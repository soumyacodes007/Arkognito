// The record envelope (PRD §5 "Record envelope", R1, F1, F2).
//
// Every Arkognito record's payload is JSON: { v, app, ct, exp, data, sig, pad }.
// `sig` is S's EIP-191 signature over keccak(domain, app, ct, exp, data, canonical attributes), so a
// relayer that edits content, attributes or the expiry bucket is caught: the signature no longer
// recovers to $owner.
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  recoverMessageAddress,
} from "viem"
import { canonicalAttributes } from "./attrs.ts"
import type { ArkognitoSigner } from "./vault.ts"
import { BLOCK_TIME_SECONDS, ENVELOPE_VERSION, EXPIRY_BUCKETS, PAD_BUCKETS } from "./constants.ts"

export type Envelope = {
  v: number
  app: string
  ct: string
  exp: number
  /**
   * 0: plaintext. 1: encrypted to the owner (AES-256-GCM, iv || ciphertext). 2: sealed, the key held
   * by key-keepers only while the record lives (seal.ts).
   */
  enc: 0 | 1 | 2
  data: string
  sig: Hex
  pad?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Rounds a lifetime in seconds up to the next bucket (F1). Lifetimes past the largest bucket are refused. */
export function expiryBucket(seconds: number): number {
  if (!(seconds > 0)) throw new Error("expiry must be a positive duration")
  const bucket = EXPIRY_BUCKETS.find((b) => b >= seconds)
  if (bucket === undefined) {
    throw new Error(`expiry of ${seconds}s is past the largest bucket (${EXPIRY_BUCKETS.at(-1)}s)`)
  }
  return bucket
}

/** Lifetime in seconds of an SDK `Expiry` (from `ExpirationTime.fromHours(...)` etc.), or a plain number of seconds. */
export function expirySeconds(expires: { minLifetime: bigint } | number): number {
  if (typeof expires === "number") return expires
  if (typeof expires?.minLifetime !== "bigint" || expires.minLifetime <= 0n) {
    throw new Error("Arkognito needs a relative expiry (ExpirationTime.fromHours/fromDays/...), not an absolute one")
  }
  return Number(expires.minLifetime) * BLOCK_TIME_SECONDS
}

export function envelopeDigest(e: Pick<Envelope, "app" | "ct" | "exp" | "enc" | "data">, attributes: AttributeInputs | Attributes | undefined): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "uint64" },
        { type: "uint8" },
        { type: "string" },
        { type: "string" },
      ],
      ["arkognito/envelope/v1", e.app, e.ct, BigInt(e.exp), e.enc, e.data, canonicalAttributes(attributes)],
    ),
  )
}

/** Pads the serialised envelope with a `pad` field up to the next size bucket (F2). */
export function padEnvelope(body: Omit<Envelope, "pad">, reserve = 0): string {
  const baseBytes = enc.encode(JSON.stringify(body)).length
  const overhead = ',"pad":""'.length
  const bucket = PAD_BUCKETS.find((b) => b >= baseBytes + overhead + reserve)
  if (bucket === undefined) {
    throw new Error(`record is ${baseBytes} bytes; the largest Arkognito record is ${PAD_BUCKETS.at(-1)} bytes (X3)`)
  }
  const padded = JSON.stringify({ ...body, pad: "0".repeat(bucket - baseBytes - overhead) })
  if (enc.encode(padded).length !== bucket) throw new Error("padding miscalculated")
  return padded
}

/** Builds, signs and pads an envelope. Returns the payload bytes to store. */
export async function sealEnvelope(params: {
  signer: ArkognitoSigner
  app: string
  payload: Uint8Array
  contentType: string
  attributes?: AttributeInputs
  expSeconds: number
  /** Set when `payload` is already encrypted to the owner. */
  encrypted?: boolean
  /** Set when `payload` is a sealed payload (seal.ts). */
  sealed?: boolean
}): Promise<{ payload: Uint8Array; envelope: Envelope; text: string }> {
  const body = {
    v: ENVELOPE_VERSION,
    app: params.app,
    ct: params.contentType,
    exp: params.expSeconds,
    enc: (params.sealed ? 2 : params.encrypted ? 1 : 0) as 0 | 1 | 2,
    data: toBase64(params.payload),
  }
  const sig = await params.signer.signEnvelope(body, params.attributes)
  // Size as if encrypted (12-byte IV + 16-byte GCM tag), so a plaintext record and an encrypted one
  // of the same input land in the same size bucket: encryption must not stand out.
  const encryptedLength = Math.ceil((params.payload.length + (params.encrypted || params.sealed ? 0 : 28)) / 3) * 4
  const text = padEnvelope({ ...body, sig }, encryptedLength - body.data.length)
  return { payload: enc.encode(text), envelope: JSON.parse(text) as Envelope, text }
}

export function parseEnvelope(payload: Uint8Array | string): Envelope {
  const text = typeof payload === "string" ? payload : dec.decode(payload)
  const e = JSON.parse(text) as Envelope
  if (e?.v !== ENVELOPE_VERSION || typeof e.data !== "string" || typeof e.sig !== "string" || (e.enc !== 0 && e.enc !== 1 && e.enc !== 2)) {
    throw new Error("not a Arkognito v1 envelope")
  }
  return e
}

/** Address that signed the envelope over these attributes. */
export function envelopeSigner(e: Envelope, attributes: AttributeInputs | Attributes | undefined): Promise<Address> {
  return recoverMessageAddress({ message: { raw: envelopeDigest(e, attributes) }, signature: e.sig })
}
