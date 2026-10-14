// Cover records (B5): they must be indistinguishable from the real record they copy.
import assert from "node:assert/strict"
import { test } from "node:test"
import { ExpirationTime } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type SubmitRequest, KeyVault, envelopeSigner, parseEnvelope, sealEnvelope, toWire } from "arkognito"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { BatchItem } from "../src/batcher"
import { coverFor, coverLike } from "../src/cover"
import { validateSubmission } from "../src/server"

const app = "cover-test"
const relayer = privateKeyToAccount(generatePrivateKey()).address
const limits = { maxMinAnonymity: 50, maxHoldMs: 60_000 }
const enc = new TextEncoder()

async function item(encrypted: boolean, text = "a report about stock levels"): Promise<BatchItem> {
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
  const vault = await KeyVault.fromWallet(wallet, app)
  const key = await vault.newRecord()
  const signer = await vault.signer(key.ref)
  const attributes = { project: app, type: "report", district: "north", vtag: key.tag }
  const payload = encrypted ? await vault.encrypt(key.ref, enc.encode(text)) : enc.encode(text)
  const sealed = await sealEnvelope({ signer, app, payload, contentType: "application/json", attributes, expSeconds: 86_400, encrypted })
  const body: SubmitRequest = { app, owner: key.address, envelope: sealed.text, attributes: toWire(attributes), expSeconds: 86_400 }
  const it = await validateSubmission(body, relayer, limits)
  it.sideCreates = [
    {
      payload: new Uint8Array(),
      contentType: "application/octet-stream",
      attributes: { project: "arkognito-7f3k", type: "arkognito.spent", app, epoch: i32(20_000), tokenid: bytes32(`0x${"11".repeat(32)}`) },
      expires: ExpirationTime.fromBlocks(1000),
    },
  ]
  return it
}

test("B5: a cover record matches the real one in size, attributes, type and expiry, and is validly signed", async () => {
  const real = await item(true)
  const cover = await coverLike(real)
  assert.ok(cover)
  assert.equal(cover.cover, true)
  assert.equal(enc.encode(cover.envelope).length, enc.encode(real.envelope).length, "same padded size")
  const [re, ce] = [parseEnvelope(real.envelope), parseEnvelope(cover.envelope)]
  assert.equal(ce.app, re.app)
  assert.equal(ce.ct, re.ct)
  assert.equal(ce.exp, re.exp)
  assert.equal(ce.enc, 1)
  assert.equal(ce.data.length, re.data.length, "same ciphertext length")
  assert.notEqual(ce.data, re.data)
  assert.equal(cover.expSeconds, real.expSeconds)
  const strip = (a: unknown) => Object.fromEntries(Object.entries(toWire(a as never)).filter(([k]) => k !== "vtag"))
  assert.deepEqual(strip(cover.attributes), strip(real.attributes))
  assert.equal(toWire(cover.attributes).vtag.type, toWire(real.attributes).vtag.type)
  const vtag = (a: unknown) => String(toWire(a as never).vtag.value)
  assert.equal(vtag(cover.attributes).length, vtag(real.attributes).length)
  assert.notEqual(vtag(cover.attributes), vtag(real.attributes))
  assert.notEqual(cover.owner, real.owner)
  assert.equal((await envelopeSigner(ce, cover.attributes)).toLowerCase(), cover.owner.toLowerCase(), "signed by its own owner, like a real record")
  // The relayer's own validation accepts it exactly like a client's submission.
  await validateSubmission({ app, owner: cover.owner, envelope: cover.envelope, attributes: toWire(cover.attributes), expSeconds: cover.expSeconds }, relayer, limits)
  // A spent marker of its own, with a different token id.
  const marker = cover.sideCreates?.[0]?.attributes as Record<string, unknown>
  assert.ok(marker)
  assert.notDeepEqual(marker.tokenid, (real.sideCreates?.[0]?.attributes as Record<string, unknown>).tokenid)
  assert.deepEqual(marker.epoch, (real.sideCreates?.[0]?.attributes as Record<string, unknown>).epoch)
})

test("B5: a batch is filled up to the minimum, and only from encrypted records", async () => {
  const enc1 = await item(true)
  const plain = await item(false)
  assert.equal((await coverFor([enc1], 5)).length, 4)
  assert.equal((await coverFor([enc1, plain], 5)).length, 3)
  assert.equal((await coverFor([plain], 5)).length, 0, "random bytes cannot pass for plaintext: no cover")
  assert.equal(await coverLike(plain), undefined)
  assert.equal((await coverFor([enc1, enc1, enc1, enc1, enc1], 5)).length, 0, "a full batch needs none")
})

test("B5: an inbox record's cover is also signed by a key other than its owner", async () => {
  const real = await item(true)
  real.inbox = true
  const cover = await coverLike(real)
  assert.ok(cover?.inbox)
  const signer = await envelopeSigner(parseEnvelope(cover!.envelope), cover!.attributes)
  assert.notEqual(signer.toLowerCase(), cover!.owner.toLowerCase())
})
