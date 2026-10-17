// Shamir secret sharing over GF(2^8), byte by byte (the AES field, polynomial x^8 + x^4 + x^3 + x + 1).
// Any `threshold` shares rebuild the secret; fewer reveal nothing about it.
//
// A share is its x-coordinate (1..255) followed by one y byte per secret byte.

const EXP = new Uint8Array(510)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    // multiply by the generator 3: x * 2 xor x, reduced
    let x2 = x << 1
    if (x2 & 0x100) x2 ^= 0x11b
    x = x2 ^ x
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const div = (a: number, b: number) => {
  if (b === 0) throw new Error("division by zero")
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]
}

/** Splits `secret` into `shares` shares, any `threshold` of which rebuild it. */
export function split(secret: Uint8Array, shares: number, threshold: number): Uint8Array[] {
  if (!Number.isInteger(shares) || !Number.isInteger(threshold) || threshold < 1 || threshold > shares || shares > 255) {
    throw new Error("need 1 <= threshold <= shares <= 255")
  }
  const out = Array.from({ length: shares }, (_, i) => {
    const s = new Uint8Array(secret.length + 1)
    s[0] = i + 1
    return s
  })
  const coeffs = new Uint8Array(threshold)
  for (let b = 0; b < secret.length; b++) {
    coeffs[0] = secret[b]
    crypto.getRandomValues(coeffs.subarray(1))
    for (const s of out) {
      // Horner's rule at x = s[0]
      let y = 0
      for (let c = threshold - 1; c >= 0; c--) y = mul(y, s[0]) ^ coeffs[c]
      s[b + 1] = y
    }
  }
  coeffs.fill(0)
  return out
}

/** Rebuilds the secret from at least `threshold` distinct shares (Lagrange interpolation at x = 0). */
export function combine(shares: Uint8Array[]): Uint8Array {
  if (shares.length === 0) throw new Error("no shares")
  const len = shares[0].length
  const xs = shares.map((s) => s[0])
  if (shares.some((s) => s.length !== len) || xs.some((x) => x === 0) || new Set(xs).size !== xs.length) {
    throw new Error("shares are malformed or repeated")
  }
  const out = new Uint8Array(len - 1)
  for (let b = 1; b < len; b++) {
    let acc = 0
    for (let i = 0; i < shares.length; i++) {
      let basis = 1
      for (let j = 0; j < shares.length; j++) {
        if (i !== j) basis = mul(basis, div(xs[j], xs[j] ^ xs[i]))
      }
      acc ^= mul(shares[i][b], basis)
    }
    out[b - 1] = acc
  }
  return out
}
