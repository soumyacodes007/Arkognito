// Oblivious HTTP for relayer calls (R7, T3). The client encrypts each request to the relayer's
// gateway key and sends it through an independent OHTTP relay: the relay sees the client's IP but
// not the request; the relayer sees the request but only the relay's IP. As long as the two do not
// collude, no single party learns which IP sent which record.
//
// Encapsulation follows RFC 9458 §4 (HPKE base mode, X25519 / HKDF-SHA256 / AES-128-GCM). The inner
// message is a small JSON request rather than Binary HTTP, so the media labels are Arkognito's own.
// Gateway keys are published in each relayer's `arkognito.relayer` heartbeat on Arkiv; clients take the
// key from there, never from the relay, so a relay cannot substitute its own key.
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import { gcm } from "@noble/ciphers/aes.js"
import { expand, extract } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, type Hex } from "viem"

export type InnerRequest = { method: "GET" | "POST"; path: string; body?: unknown }
export type InnerResponse = { status: number; body: unknown }

const KEY_ID = 1
const KEM_ID = 0x0020
const KDF_ID = 0x0001
const AEAD_ID = 0x0001
const NK = 16
const NN = 12
const REQUEST_LABEL = "message/arkognito-ohttp request"
const RESPONSE_LABEL = "message/arkognito-ohttp response"
const enc = new TextEncoder()
const dec = new TextDecoder()

const suite = () => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() })

function header(): Uint8Array {
  const h = new Uint8Array(7)
  const v = new DataView(h.buffer)
  v.setUint8(0, KEY_ID)
  v.setUint16(1, KEM_ID)
  v.setUint16(3, KDF_ID)
  v.setUint16(5, AEAD_ID)
  return h
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const u8 = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b))
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer

function responseKeys(secret: Uint8Array, encapsulated: Uint8Array, responseNonce: Uint8Array) {
  const prk = extract(sha256, secret, cat(encapsulated, responseNonce))
  return { key: expand(sha256, prk, enc.encode("key"), NK), nonce: expand(sha256, prk, enc.encode("nonce"), NN) }
}

/** Client side: one request through an OHTTP relay to the gateway whose public key is `gatewayKey`. */
export async function ohttpCall(
  relayUrl: string,
  target: string,
  gatewayKey: Hex,
  inner: InnerRequest,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<InnerResponse> {
  const s = suite()
  const hdr = header()
  const pk = await s.kem.deserializePublicKey(buf(hexToBytes(gatewayKey)))
  const sender = await s.createSenderContext({ recipientPublicKey: pk, info: buf(cat(enc.encode(REQUEST_LABEL), new Uint8Array([0]), hdr)) })
  const ct = u8(await sender.seal(buf(enc.encode(JSON.stringify(inner)))))
  const encapsulated = u8(sender.enc)
  const res = await fetchFn(`${relayUrl.replace(/\/$/, "")}/ohttp`, {
    method: "POST",
    headers: { "content-type": "message/ohttp-req", "x-arkognito-target": target },
    body: buf(cat(hdr, encapsulated, ct)),
  })
  if (!res.ok) throw new Error(`OHTTP relay refused: ${res.status} ${await res.text()}`)
  const body = u8(await res.arrayBuffer())
  const secret = u8(await sender.export(buf(enc.encode(RESPONSE_LABEL)), NK))
  const responseNonce = body.subarray(0, Math.max(NN, NK))
  const { key, nonce } = responseKeys(secret, encapsulated, responseNonce)
  const plain = gcm(key, nonce).decrypt(body.subarray(Math.max(NN, NK)))
  return JSON.parse(dec.decode(plain)) as InnerResponse
}

/** Gateway side, run by a relayer. The key derives from a seed so it survives restarts. */
export class OhttpGateway {
  private constructor(
    private keyPair: CryptoKeyPair,
    readonly publicKey: Hex,
  ) {}

  static async fromSeed(seed: Uint8Array): Promise<OhttpGateway> {
    const s = suite()
    const ikm = expand(sha256, extract(sha256, seed, enc.encode("arkognito/ohttp/v1")), enc.encode("gateway"), 32)
    const kp = await s.kem.deriveKeyPair(buf(ikm))
    const pub = u8(await s.kem.serializePublicKey(kp.publicKey))
    return new OhttpGateway(kp, bytesToHex(pub))
  }

  /** Opens an encapsulated request; returns it with a function that seals the matching response. */
  async open(message: Uint8Array): Promise<{ request: InnerRequest; seal(r: InnerResponse): Promise<Uint8Array> }> {
    const s = suite()
    if (message.length < 7 + 32 + 16) throw new Error("OHTTP request too short")
    const hdr = message.subarray(0, 7)
    const v = new DataView(hdr.buffer, hdr.byteOffset, 7)
    if (v.getUint8(0) !== KEY_ID || v.getUint16(1) !== KEM_ID || v.getUint16(3) !== KDF_ID || v.getUint16(5) !== AEAD_ID) {
      throw new Error("unsupported OHTTP key configuration")
    }
    const encapsulated = message.slice(7, 7 + 32)
    const recipient = await s.createRecipientContext({
      recipientKey: this.keyPair,
      enc: buf(encapsulated),
      info: buf(cat(enc.encode(REQUEST_LABEL), new Uint8Array([0]), hdr)),
    })
    const plain = u8(await recipient.open(buf(message.subarray(7 + 32))))
    const request = JSON.parse(dec.decode(plain)) as InnerRequest
    const secret = u8(await recipient.export(buf(enc.encode(RESPONSE_LABEL)), NK))
    return {
      request,
      async seal(r: InnerResponse) {
        const responseNonce = crypto.getRandomValues(new Uint8Array(Math.max(NN, NK)))
        const { key, nonce } = responseKeys(secret, encapsulated, responseNonce)
        return cat(responseNonce, gcm(key, nonce).encrypt(enc.encode(JSON.stringify(r))))
      },
    }
  }
}
