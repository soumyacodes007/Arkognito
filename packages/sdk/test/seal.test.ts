// Real expiry building blocks: Shamir sharing, sealed payloads, share release encryption.
import assert from "node:assert/strict"
import { test } from "node:test"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { combineShares, decryptShare, encryptShare, newRequesterKey, openPayload, readSealHeader, sealPayload, splitSecret } from "../src/index.ts"

const enc = new TextEncoder()
const keepers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address)

test("shamir: any t of n shares rebuild the secret; t-1 do not", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const shares = splitSecret(secret, 5, 3)
  for (const pick of [[0, 1, 2], [4, 2, 0], [1, 3, 4]]) {
    assert.deepEqual(combineShares(pick.map((i) => shares[i])), secret)
  }
  assert.notDeepEqual(combineShares([shares[0], shares[1]]), secret)
  assert.throws(() => combineShares([shares[0], shares[0]]), /repeated/)
})

test("seal: 2-of-3 keepers open the payload; the header names keepers and threshold", () => {
  const sealed = sealPayload(enc.encode("disappearing report"), keepers, 2)
  const h = readSealHeader(sealed.data)
  assert.equal(h.threshold, 2)
  assert.deepEqual(h.keepers, keepers)
  assert.equal(h.sealId, sealed.sealId)
  assert.equal(new TextDecoder().decode(openPayload(sealed.data, [sealed.shares[2], sealed.shares[0]])), "disappearing report")
  assert.throws(() => openPayload(sealed.data, [sealed.shares[1]]), /need 2 shares/)
  const tampered = sealed.data.slice()
  tampered[1] = 1
  assert.throws(() => openPayload(tampered, sealed.shares))
})

test("seal: a released share opens only for the requester's key", () => {
  const share = sealPayload(enc.encode("x"), keepers, 2).shares[0]
  const me = newRequesterKey()
  const box = encryptShare(share, me.publicKey)
  assert.deepEqual(decryptShare(me.secret, box), share)
  assert.throws(() => decryptShare(newRequesterKey().secret, box))
})
