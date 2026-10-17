// Real expiry: sealed payloads whose key lives only with key-keepers, and only while the record lives.
//
// Arkiv expiry hides an entity from queries but keeps its payload in history (arkiv/friction.md).
// A sealed record makes expiry final: the payload is encrypted under a fresh key K, K is split
// t-of-n (shamir.ts) across key-keepers, and each keeper hands its share out only while the
// entity is alive on chain, then deletes it. After expiry, or after the owner destroys it early,
// the ciphertext is still in every archive, but no key exists anywhere.
//
//   envelope.enc = 2, envelope.data = base64(header || iv (12) || AES-256-GCM(K, payload))
//   header      = version (1) || t (1) || n (1) || sealId (32) || n keeper addresses (20 each)
//
// The header is inside the signed envelope, so the keepers and threshold cannot be swapped. The
// sealId names the shares at the keepers; it is random, and public once the record is written.
import { gcm } from "@noble/ciphers/aes.js"
import { x25519 } from "@noble/curves/ed25519"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { type Address, type Hex, bytesToHex, getAddress, hexToBytes } from "viem"
import { combine, split } from "./shamir.ts"

export const SEAL_VERSION = 1
const enc = new TextEncoder()

/** Who a keeper releases shares to: only the record's on-chain owner, or anyone who asks while it lives. */
export type SealReaders = "owner" | "anyone"

export type SealHeader = { threshold: number; keepers: Address[]; sealId: Hex }

export type SealedPayload = {
  /** What goes in the envelope's `data` (before base64), with `enc = 2`. */
  data: Uint8Array
  sealId: Hex
  /** One share per keeper, in the order of `keepers`. */
  shares: Uint8Array[]
}

export function sealPayload(payload: Uint8Array, keepers: readonly Address[], threshold: number): SealedPayload {
  const n = keepers.length
  if (n < 1 || n > 7) throw new Error("a sealed record needs 1 to 7 keepers")
  if (!(threshold >= 1 && threshold <= n)) throw new Error(`threshold must be 1 to ${n}`)
  const key = crypto.getRandomValues(new Uint8Array(32))
  const sealId = crypto.getRandomValues(new Uint8Array(32))
  const header = new Uint8Array(3 + 32 + 20 * n)
  header[0] = SEAL_VERSION
  header[1] = threshold
  header[2] = n
  header.set(sealId, 3)
  keepers.forEach((k, i) => header.set(hexToBytes(getAddress(k)), 35 + 20 * i))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  // The header is bound as associated data: it cannot be detached from this ciphertext.
  const ct = gcm(key, iv, header).encrypt(payload)
  const shares = split(key, n, threshold)
  key.fill(0)
  return { data: concat(header, iv, ct), sealId: bytesToHex(sealId), shares }
}

export function readSealHeader(data: Uint8Array): SealHeader & { headerLength: number } {
  if (data.length < 35 || data[0] !== SEAL_VERSION) throw new Error("not a sealed payload")
  const threshold = data[1]
  const n = data[2]
  const headerLength = 35 + 20 * n
  if (n < 1 || n > 7 || threshold < 1 || threshold > n || data.length < headerLength + 28) throw new Error("malformed seal header")
  const keepers = Array.from({ length: n }, (_, i) => getAddress(bytesToHex(data.subarray(35 + 20 * i, 55 + 20 * i))))
  return { threshold, keepers, sealId: bytesToHex(data.subarray(3, 35)), headerLength }
}

/** Opens a sealed payload with at least `threshold` shares. */
export function openPayload(data: Uint8Array, shares: Uint8Array[]): Uint8Array {
  const h = readSealHeader(data)
  if (shares.length < h.threshold) throw new Error(`need ${h.threshold} shares, have ${shares.length}`)
  const key = combine(shares.slice(0, h.threshold))
  try {
    const header = data.subarray(0, h.headerLength)
    const iv = data.subarray(h.headerLength, h.headerLength + 12)
    return gcm(key, iv, header).decrypt(data.subarray(h.headerLength + 12))
  } finally {
    key.fill(0)
  }
}

// ---- share release: a keeper encrypts a share to the requester's one-time X25519 key -------------

export function newRequesterKey(): { secret: Uint8Array; publicKey: Hex } {
  const secret = x25519.utils.randomPrivateKey()
  return { secret, publicKey: bytesToHex(x25519.getPublicKey(secret)) }
}

function releaseKey(shared: Uint8Array, epk: Uint8Array, rpk: Uint8Array) {
  return hkdf(sha256, shared, concat(epk, rpk), enc.encode("arkognito/keeper/release/v1"), 32)
}

/** Keeper side: the share, readable only by the holder of `requesterKey`'s secret. */
export function encryptShare(share: Uint8Array, requesterKey: Hex): { epk: Hex; box: Hex } {
  const rpk = hexToBytes(requesterKey)
  if (rpk.length !== 32) throw new Error("requester key must be 32 bytes")
  const esk = x25519.utils.randomPrivateKey()
  const epk = x25519.getPublicKey(esk)
  const key = releaseKey(x25519.getSharedSecret(esk, rpk), epk, rpk)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return { epk: bytesToHex(epk), box: bytesToHex(concat(iv, gcm(key, iv).encrypt(share))) }
}

export function decryptShare(secret: Uint8Array, sealed: { epk: Hex; box: Hex }): Uint8Array {
  const epk = hexToBytes(sealed.epk)
  const rpk = x25519.getPublicKey(secret)
  const key = releaseKey(x25519.getSharedSecret(secret, epk), epk, rpk)
  const box = hexToBytes(sealed.box)
  return gcm(key, box.subarray(0, 12)).decrypt(box.subarray(12))
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
