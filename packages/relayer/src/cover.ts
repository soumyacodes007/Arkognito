// Cover records (B5): when a batch is smaller than COVER_MIN_BATCH, the relayer fills it with records
// of its own that look exactly like the real ones, so a lone writer is never alone in a batch.
//
// A cover record copies a real record's app, attributes (except its tag), content type, expiry and
// payload size, with random ciphertext, a random tag and a fresh one-time owner that really signs it.
// With tokens on, it gets a spent marker too, with a random token id. Only encrypted records are
// copied: random bytes cannot pass for someone's plaintext, so a batch of plaintext records gets no
// cover. An inbox record's cover is signed by a key other than its owner, like the real one.
import { bytes32, str } from "@arkiv-network/sdk/attr"
import { type ArkognitoSigner, envelopeDigest, fromBase64, parseEnvelope, sealEnvelope } from "arkognito"
import { bytesToHex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { BatchItem } from "./batcher"

const enc = new TextEncoder()

function randomTag(): string {
  const b = crypto.getRandomValues(new Uint8Array(44))
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signerFor(owner = privateKeyToAccount(generatePrivateKey()), signWith = owner): ArkognitoSigner {
  return {
    address: signWith.address,
    signEnvelope: (body, attributes) => signWith.signMessage({ message: { raw: envelopeDigest(body, attributes) } }),
    signProof: () => Promise.reject(new Error("cover records prove nothing")),
  }
}

/** A cover record shaped like `template`, or undefined when the template cannot be copied safely. */
export async function coverLike(template: BatchItem): Promise<BatchItem | undefined> {
  let env
  try {
    env = parseEnvelope(template.envelope)
  } catch {
    return undefined
  }
  if (env.enc !== 1) return undefined
  const owner = privateKeyToAccount(generatePrivateKey())
  const signer = template.inbox ? signerFor(owner, privateKeyToAccount(generatePrivateKey())) : signerFor(owner)
  const attributes = { ...template.attributes, vtag: str(randomTag()) }
  const sealed = await sealEnvelope({
    signer,
    app: env.app,
    payload: crypto.getRandomValues(new Uint8Array(fromBase64(env.data).length)),
    contentType: env.ct,
    attributes,
    expSeconds: template.expSeconds,
    encrypted: true,
  })
  // Same bucket or nothing: a cover record of a different size would stand out.
  if (enc.encode(sealed.text).length !== enc.encode(template.envelope).length) return undefined
  return {
    id: `cover-${crypto.randomUUID()}`,
    owner: owner.address,
    envelope: sealed.text,
    attributes,
    expSeconds: template.expSeconds,
    receivedAt: Date.now(),
    inbox: template.inbox,
    cover: true,
    sideCreates: template.sideCreates?.map((c) => ({
      ...c,
      attributes: { ...c.attributes, ...("tokenid" in (c.attributes ?? {}) ? { tokenid: bytes32(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))) } : {}) },
    })),
  }
}

/** Cover records to bring `batch` up to `min`, each copied from a random encrypted record in it. */
export async function coverFor(batch: BatchItem[], min: number): Promise<BatchItem[]> {
  const need = min - batch.length
  if (need <= 0) return []
  const templates = batch.filter((it) => {
    try {
      return parseEnvelope(it.envelope).enc === 1
    } catch {
      return false
    }
  })
  if (templates.length === 0) return []
  const out: BatchItem[] = []
  for (let i = 0; i < need; i++) {
    const t = templates[Math.floor(Math.random() * templates.length)]
    const c = await coverLike(t)
    if (c) out.push(c)
  }
  return out
}
