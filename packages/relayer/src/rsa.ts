// Deterministic RSA-2048 key generation from a secret seed.
//
// Why: the issuer must publish exactly one key per app per day (T1). A key held only in memory
// would be lost on restart, and publishing a replacement would look exactly like equivocation.
// Deriving the day's key from a secret seed means a restarted issuer recreates the same key, and
// nothing secret ever has to be stored on Arkiv or on disk.
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"

const E = 65537n
const SMALL_PRIMES: bigint[] = (() => {
  const out: bigint[] = []
  for (let n = 3; out.length < 300; n += 2) if (out.every((p) => n % Number(p) !== 0)) out.push(BigInt(n))
  return out
})()

/** Deterministic byte stream: SHA-256(seed || counter). */
function stream(seed: Uint8Array) {
  let counter = 0
  return (len: number): Uint8Array => {
    const out = new Uint8Array(len)
    for (let off = 0; off < len; off += 32) {
      const block = new Uint8Array(seed.length + 4)
      block.set(seed)
      new DataView(block.buffer).setUint32(seed.length, counter++)
      out.set(sha256(block).subarray(0, Math.min(32, len - off)), off)
    }
    return out
  }
}

const toBig = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`)

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n
  b %= m
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}

function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [a % m, m]
  let [s0, s1] = [1n, 0n]
  while (r1 !== 0n) {
    const q = r0 / r1
    ;[r0, r1] = [r1, r0 - q * r1]
    ;[s0, s1] = [s1, s0 - q * s1]
  }
  if (r0 !== 1n) throw new Error("not invertible")
  return ((s0 % m) + m) % m
}

function probablyPrime(n: bigint, rand: (len: number) => Uint8Array, rounds = 40): boolean {
  for (const p of SMALL_PRIMES) if (n % p === 0n) return n === p
  let d = n - 1n
  let s = 0
  while ((d & 1n) === 0n) {
    d >>= 1n
    s++
  }
  outer: for (let i = 0; i < rounds; i++) {
    const a = 2n + (toBig(rand(136)) % (n - 4n))
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) continue
    for (let r = 1; r < s; r++) {
      x = (x * x) % n
      if (x === n - 1n) continue outer
    }
    return false
  }
  return true
}

function genPrime(bits: number, rand: (len: number) => Uint8Array): bigint {
  for (;;) {
    let c = toBig(rand(bits / 8))
    c |= (1n << BigInt(bits - 1)) | (1n << BigInt(bits - 2)) | 1n
    if ((c - 1n) % E === 0n) continue
    if (probablyPrime(c, rand)) return c
  }
}

const b64u = (n: bigint) => {
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, "hex").toString("base64url")
}

/** RSA-2048 key pair for RSA-PSS/SHA-384, derived from `seed` and `label`. */
export async function deriveRsaKeyPair(seed: Uint8Array, label: string) {
  const rand = stream(hkdf(sha256, seed, undefined, new TextEncoder().encode(`arkognito/issuer-rsa/v1/${label}`), 32))
  let p = genPrime(1024, rand)
  let q = genPrime(1024, rand)
  while (p === q) q = genPrime(1024, rand)
  if (p < q) [p, q] = [q, p]
  const n = p * q
  const d = modInv(E, (p - 1n) * (q - 1n))
  const jwk: JsonWebKey = {
    kty: "RSA",
    n: b64u(n),
    e: b64u(E),
    d: b64u(d),
    p: b64u(p),
    q: b64u(q),
    dp: b64u(d % (p - 1n)),
    dq: b64u(d % (q - 1n)),
    qi: b64u(modInv(q, p)),
    alg: "PS384",
    ext: true,
  }
  const algo = { name: "RSA-PSS", hash: "SHA-384" }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, algo, true, ["sign"])
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "PS384", ext: true }, algo, true, ["verify"])
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", publicKey)).toString("base64")
  return { privateKey, publicKey, spki, n, d }
}
