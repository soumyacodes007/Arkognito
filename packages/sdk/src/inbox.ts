// "Send to user": records someone else writes for you, owned by a one-time address only you control
// (stealth addresses, as in ERC-5564, on secp256k1).
//
//   inbox address = "arkognito-inbox1:" || K_spend (33 bytes) || K_view (33 bytes), both from your root
//   sender:   r random with R = rG of even y;  shared = x(r · K_view)
//             c = scalar(shared, "owner"), owner = addr(K_spend + cG)        only you know k_spend + c
//             envelope signed by k_sig = scalar(shared, "sign")               sender and you both know it
//             payload encrypted under HKDF(shared, "data")
//             tag = x(R) (32) || view tag (1) || 11 random bytes: 44 bytes, like every other tag
//   you:      for each tag, shared = x(k_view · R); the view tag skips most non-matches cheaply
//
// What an observer can tell: an inbox record's envelope is signed by a key other than its owner, so
// it is recognisable as an inbox record. Not who it is for, not who sent it, not what it says.
import { secp256k1 } from "@noble/curves/secp256k1"
import { gcm } from "@noble/ciphers/aes.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { type Address, type Hex, bytesToHex } from "viem"
import { privateKeyToAccount, publicKeyToAddress, type PrivateKeyAccount } from "viem/accounts"

const Point = secp256k1.ProjectivePoint
type Pt = InstanceType<typeof Point>
const N = secp256k1.CURVE.n
const enc = new TextEncoder()

export const INBOX_PREFIX = "arkognito-inbox1:"

/** The derived secrets of one inbox record, from the ECDH shared x-coordinate. */
export type InboxSecrets = { ownerTweak: bigint; signKey: Hex; dataKey: Uint8Array; viewTag: number }

/** 48 bytes of HKDF output reduced mod n-1, plus 1: a valid scalar with negligible bias. */
export function scalarFrom(ikm: Uint8Array, info: string): bigint {
  const okm = hkdf(sha256, ikm, undefined, enc.encode(info), 48)
  return (BigInt(bytesToHex(okm)) % (N - 1n)) + 1n
}

export const scalarHex = (k: bigint): Hex => `0x${k.toString(16).padStart(64, "0")}`

export function inboxSecrets(sharedX: Uint8Array, app: string): InboxSecrets {
  return {
    ownerTweak: scalarFrom(sharedX, `arkognito/inbox/owner/v1|${app}`),
    signKey: scalarHex(scalarFrom(sharedX, `arkognito/inbox/sign/v1|${app}`)),
    dataKey: hkdf(sha256, sharedX, undefined, enc.encode(`arkognito/inbox/data/v1|${app}`), 32),
    viewTag: hkdf(sha256, sharedX, undefined, enc.encode(`arkognito/inbox/viewtag/v1|${app}`), 1)[0],
  }
}

export function formatInboxAddress(spendPub: Uint8Array, viewPub: Uint8Array): string {
  return `${INBOX_PREFIX}${bytesToHex(spendPub).slice(2)}${bytesToHex(viewPub).slice(2)}`
}

export function parseInboxAddress(address: string): { spend: Pt; view: Pt } {
  const m = address.trim().match(/^arkognito-inbox1:([0-9a-f]{66})([0-9a-f]{66})$/i)
  if (!m) throw new Error("not an Arkognito inbox address")
  try {
    return { spend: Point.fromHex(m[1]), view: Point.fromHex(m[2]) }
  } catch {
    throw new Error("inbox address holds an invalid public key")
  }
}

export const pubOf = (k: bigint) => Point.BASE.multiply(k).toRawBytes(true)
export const addressOfPoint = (p: Pt): Address => publicKeyToAddress(bytesToHex(p.toRawBytes(false)))

/** x(k · R), where R is the even-y point with this x-coordinate. Null when x is not on the curve. */
export function sharedFromTagX(x: Uint8Array, k: bigint): Uint8Array | null {
  let R: Pt
  try {
    R = Point.fromHex(concat(new Uint8Array([2]), x))
  } catch {
    return null
  }
  return R.multiply(k).toRawBytes(true).slice(1)
}

/** The owner a recipient controls for these secrets: K_spend + cG. */
export function inboxOwner(spend: Pt, s: InboxSecrets): Address {
  return addressOfPoint(spend.add(Point.BASE.multiply(s.ownerTweak)))
}

/** The owner's private key, for the recipient: k_spend + c. */
export function inboxOwnerKey(spendKey: bigint, s: InboxSecrets): Hex {
  return scalarHex((spendKey + s.ownerTweak) % N)
}

export type SealedInboxKey = {
  /** One-time owner: only the recipient can sign as it. */
  owner: Address
  /** Signs the envelope. Derived from the shared secret, so the recipient can check it. */
  envelopeSigner: PrivateKeyAccount
  /** The record's `vtag`. */
  tag: string
  /** Encrypts the payload so only the recipient can read it. */
  encrypt(data: Uint8Array): Uint8Array
}

/** Sender side: a fresh one-time owner, tag and keys for one record addressed to `inboxAddress`. */
export function sealInbox(inboxAddress: string, app: string): SealedInboxKey {
  const { spend, view } = parseInboxAddress(inboxAddress)
  let r = scalarFrom(crypto.getRandomValues(new Uint8Array(32)), "arkognito/inbox/ephemeral/v1")
  let R = Point.BASE.multiply(r)
  // Keep R's y even, so 32 bytes of x name it and the tag needs no parity byte.
  if (R.toRawBytes(true)[0] === 3) {
    r = N - r
    R = R.negate()
  }
  const shared = view.multiply(r).toRawBytes(true).slice(1)
  const s = inboxSecrets(shared, app)
  const tag = new Uint8Array(44)
  tag.set(R.toRawBytes(true).slice(1), 0)
  tag[32] = s.viewTag
  tag.set(crypto.getRandomValues(new Uint8Array(11)), 33)
  return {
    owner: inboxOwner(spend, s),
    envelopeSigner: privateKeyToAccount(s.signKey),
    tag: toB64url(tag),
    encrypt: (data) => sealData(s.dataKey, data),
  }
}

/** AES-256-GCM, iv || ciphertext: the same layout as a vault's own encryption. */
export function sealData(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return concat(iv, gcm(key, iv).encrypt(data))
}

export function openData(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 28) throw new Error("ciphertext too short")
  return gcm(key, data.subarray(0, 12)).decrypt(data.subarray(12))
}


function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export function toB64url(b: Uint8Array) {
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
