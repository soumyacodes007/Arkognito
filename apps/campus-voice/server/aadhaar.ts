// Anon Aadhaar for Campus Voice, TEST MODE ONLY.
//
// The student union admits a student once it has verified an Anon Aadhaar proof that (1) comes from a
// card signed with Anon Aadhaar's public *test* key, (2) says the holder is over 18, and (3) is bound
// to the student's membership commitments. The proof's nullifier (one per card, per app) lets the
// union refuse a second membership from the same card. Real Aadhaar cards are refused: their key is
// not the test key. Cards, proofs and nullifiers never go on Arkiv; nullifiers stay in this server's
// local state, as the project's rules require.
//
// Test cards are Anon Aadhaar's own sample card with a random photo (the nullifier is derived from
// the photo, so each card is a distinct test identity) and a fresh timestamp, re-signed with the
// published test key.

import { createHash, sign } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type AnonAadhaarCore,
  ArtifactsOrigin,
  artifactUrls,
  compressByteArray,
  convertBigIntToByteArray,
  decompressByteArray,
  extractPhoto,
  getRandomBytes,
  hash,
  init,
  replaceBytesBetween,
  returnNewDateString,
  testPublicKeyHash,
  verify,
} from "@anon-aadhaar/core"
import { STATE } from "./campus"

/** Anon Aadhaar's MIT-licensed test fixtures. The private key is public on purpose: it signs test cards only. */
const FIXTURES = "https://raw.githubusercontent.com/anon-aadhaar/anon-aadhaar/main/packages/circuits/assets/"
const DIR = join(STATE, "anon-aadhaar")

/** App-specific nullifier seed: the same card gives a different nullifier in every other app. */
export const NULLIFIER_SEED = BigInt(`0x${createHash("sha256").update("campus-voice/anon-aadhaar/v1").digest("hex").slice(0, 30)}`).toString()
/** How old a card's signature may be when it is used to join. */
const MAX_AGE_SECONDS = 24 * 3600

async function fixture(name: string): Promise<string> {
  mkdirSync(DIR, { recursive: true })
  const file = join(DIR, name)
  if (!existsSync(file)) {
    const res = await fetch(FIXTURES + name, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`could not fetch Anon Aadhaar fixture ${name}: HTTP ${res.status}`)
    writeFileSync(file, await res.text())
  }
  return readFileSync(file, "utf8")
}

export const testCertificate = () => fixture("testCertificate.pem")

/** A fresh synthetic test card, as the decimal string an Aadhaar secure QR encodes. */
export async function makeTestCard(): Promise<string> {
  const sample = JSON.parse(await fixture("test.json")) as { testQRData: string }
  const privateKey = await fixture("testPrivateKey.pem")
  const bytes = decompressByteArray(convertBigIntToByteArray(BigInt(sample.testQRData)))
  let signed: Uint8Array = bytes.slice(0, bytes.length - 256)
  if (signed[0] !== 86 || signed[1] !== 50 || signed[2] !== 255) throw new Error("the sample card is not a V2 secure QR")

  // Fresh timestamp: the reference ID is the last 4 digits followed by yyyymmddhhmmssSSS (IST), at byte 9.
  const stamp = new TextEncoder().encode(returnNewDateString())
  signed = replaceBytesBetween(signed, stamp, 9, 9 + stamp.length - 1)
  // Random photo: a new photo is a new identity, so a new nullifier.
  const { begin, dataLength } = extractPhoto(Array.from(signed), signed.length)
  const photoLength = dataLength - begin
  signed = replaceBytesBetween(signed, getRandomBytes(photoLength - 1), begin + 1, begin + photoLength - 1)

  const signature = sign("sha256", signed, privateKey) // RSA PKCS#1 v1.5, as the circuit verifies
  const card = new Uint8Array(signed.length + signature.length)
  card.set(signed, 0)
  card.set(signature, signed.length)
  const compressed = compressByteArray(card)
  return BigInt(`0x${Buffer.from(compressed).toString("hex")}`).toString()
}

/** What the student's proof must commit to: exactly these membership commitments. */
export const joinSignal = (commitments: Record<string, string>) =>
  `0x${createHash("sha256").update(`campus-voice-join:${JSON.stringify(Object.entries(commitments).sort())}`).digest("hex")}`

export type JoinCheck = { ok: true; nullifier: string } | { ok: false; reason: string }

let initialised = false
/** The union's check, before it admits anyone. */
export async function verifyJoin(pcd: AnonAadhaarCore, commitments: Record<string, string>, used: Set<string>): Promise<JoinCheck> {
  if (!initialised) {
    await init({ wasmURL: artifactUrls.v2.wasm, zkeyURL: artifactUrls.v2.zkey, vkeyURL: artifactUrls.v2.vk, artifactsOrigin: ArtifactsOrigin.server })
    initialised = true
  }
  const p = pcd?.proof
  if (!p) return { ok: false, reason: "no Anon Aadhaar proof was sent" }
  if (p.pubkeyHash !== testPublicKeyHash) return { ok: false, reason: "only Anon Aadhaar TEST cards are accepted in this demo, never a real Aadhaar" }
  if (String(p.nullifierSeed) !== NULLIFIER_SEED) return { ok: false, reason: "the proof was made for a different app" }
  if (String(p.signalHash) !== String(hash(joinSignal(commitments)))) return { ok: false, reason: "the proof is not bound to these membership tokens" }
  if (String(p.ageAbove18) !== "1") return { ok: false, reason: "the proof does not show the holder is over 18" }
  const age = Math.floor(Date.now() / 1000) - Number(p.timestamp)
  if (!(age < MAX_AGE_SECONDS)) return { ok: false, reason: "the card's signature is too old; get a new test card" }
  if (used.has(String(p.nullifier))) return { ok: false, reason: "this card has already joined Campus Voice: one person, one membership" }
  let valid = false
  try {
    valid = await verify(pcd, true)
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  if (!valid) return { ok: false, reason: "the zero-knowledge proof does not verify" }
  return { ok: true, nullifier: String(p.nullifier) }
}
