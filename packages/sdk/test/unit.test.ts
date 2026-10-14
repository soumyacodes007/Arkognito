import assert from "node:assert/strict"
import { test } from "node:test"
import { ExpirationTime } from "@arkiv-network/sdk"
import { dec, i32, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { createWalletClient, http, recoverMessageAddress, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  KeyVault,
  OhttpGateway,
  TokenWallet,
  epochOf,
  issuanceMessage,
  TAG_BYTES,
  canonicalAttributes,
  checkRarity,
  checkRecord,
  coarse,
  derivationTypedData,
  envelopeSigner,
  expiryBucket,
  fromWire,
  ohttpCall,
  parseEnvelope,
  scopeRef,
  sealEnvelope,
  signOwnershipProof,
  toWire,
  verifyOwnershipProof,
} from "../src/index.ts"

const enc = new TextEncoder()
const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
const otherWallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })

test("spike 4: the derivation message signs deterministically (local ECDSA, RFC 6979)", async () => {
  const typed = derivationTypedData("kendra-watch")
  assert.equal(await wallet.signTypedData(typed), await wallet.signTypedData(typed))
})

test("K1: a wallet that signs non-deterministically is refused", async () => {
  let n = 0
  const flaky = {
    account: wallet.account,
    signTypedData: async () => `0x${(n++).toString(16).padStart(130, "0")}`,
    signMessage: async () => "0x",
  }
  await assert.rejects(KeyVault.fromWallet(flaky as never, "x"), /two different signatures/)
})

/** A real wallet that counts how often it is asked to sign. */
function counting(w: typeof wallet) {
  const n = { typed: 0, message: 0 }
  const c = {
    account: w.account,
    signTypedData: (a: never) => (n.typed++, w.signTypedData(a)),
    signMessage: (a: never) => (n.message++, w.signMessage(a)),
  }
  return { c: c as never, n }
}

function mapStore() {
  const m = new Map<string, string>()
  return { m, store: { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) } }
}

test("K1 first-use: two prompts the first time a wallet is seen, one afterwards, same keys", async () => {
  const w = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
  const { store, m } = mapStore()
  const first = counting(w)
  const a = await KeyVault.fromWallet(first.c, "kendra-watch", { determinismStore: store })
  assert.equal(first.n.typed, 2)
  assert.equal(m.size, 1)
  const [slot, fp] = [...m.entries()][0]
  assert.match(slot, new RegExp(`^arkognito:wallet-check:7738577:kendra-watch:${w.account.address.toLowerCase()}$`))
  assert.match(fp, /^0x[0-9a-f]{32}$/)
  assert.ok(!fp.includes((await w.signTypedData(derivationTypedData("kendra-watch"))).slice(2, 34)), "the stored value is not the signature")
  const again = counting(w)
  const b = await KeyVault.fromWallet(again.c, "kendra-watch", { determinismStore: store })
  assert.equal(again.n.typed, 1)
  assert.equal(await a.addressOf(scopeRef("p")), await b.addressOf(scopeRef("p")))
  // Another app on the same device is a first use again.
  const other = counting(w)
  await KeyVault.fromWallet(other.c, "sketch", { determinismStore: store })
  assert.equal(other.n.typed, 2)
})

test("K1 first-use: a later signature that differs from the stored fingerprint is refused", async () => {
  const { store } = mapStore()
  await KeyVault.fromWallet(wallet, "fp-check", { determinismStore: store })
  const liar = { account: wallet.account, signTypedData: async () => `0x${"ab".repeat(65)}`, signMessage: async () => "0x" }
  await assert.rejects(KeyVault.fromWallet(liar as never, "fp-check", { determinismStore: store }), /two different signatures/)
})

test("K1 modes: never signs once, always signs twice every time", async () => {
  const { store } = mapStore()
  const never = counting(wallet)
  await KeyVault.fromWallet(never.c, "modes", { verifyDeterminism: "never", determinismStore: store })
  assert.equal(never.n.typed, 1)
  for (let i = 0; i < 2; i++) {
    const always = counting(wallet)
    await KeyVault.fromWallet(always.c, "modes", { verifyDeterminism: "always", determinismStore: store })
    assert.equal(always.n.typed, 2)
  }
  const legacy = counting(wallet)
  await KeyVault.fromWallet(legacy.c, "modes", { verifyDeterminism: false })
  assert.equal(legacy.n.typed, 1)
})

test("issuer identity: stable per wallet + app, unlinked to the wallet and every record key; signs issuance", async () => {
  const a = await KeyVault.fromWallet(wallet, "kendra-watch")
  const b = await KeyVault.fromWallet(wallet, "kendra-watch")
  const id = await a.issuerIdentity()
  assert.equal(id, await b.issuerIdentity())
  assert.notEqual(id, wallet.account.address)
  assert.notEqual(id, await (await KeyVault.fromWallet(wallet, "sketch")).issuerIdentity())
  assert.notEqual(id, await (await KeyVault.fromWallet(otherWallet, "kendra-watch")).issuerIdentity())
  assert.notEqual(id, await a.addressOf(scopeRef("profile")))
  assert.notEqual(id, (await a.newRecord()).address)
  const body = { app: "kendra-watch", epoch: epochOf(), blinded: ["AAAA", "BBBB"], ts: Date.now() }
  const sig = await a.signIssuance(body)
  assert.equal(await recoverMessageAddress({ message: issuanceMessage(body, body.ts), signature: sig }), id)
  await assert.rejects(a.signIssuance({ ...body, app: "sketch" }), /not sketch/)
})

test("TokenWallet with a derived identity asks the issuer without touching the wallet", async () => {
  const v = await KeyVault.fromWallet(wallet, "kendra-watch")
  const pair = (await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const issuerSpki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64")
  let posted: Record<string, unknown> | undefined
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body))
    return new Response("nope", { status: 429 })
  }) as typeof fetch
  const reader = {
    select: () => ({ where: () => ({ createdBy: () => ({ limit: () => ({ fetch: async () => ({ entities: [{ key: "0x01", toJson: () => ({ spki: issuerSpki }) }] }) }) }) }) }),
  }
  const tw = new TokenWallet({ identity: v, reader: reader as never, issuer: "0x0000000000000000000000000000000000000001", issuerUrl: "https://issuer.test", fetch: fakeFetch })
  await assert.rejects(tw.acquire("kendra-watch", 2), /issuer refused: 429/)
  assert.ok(posted)
  assert.equal(posted.wallet, await v.issuerIdentity())
  assert.equal(
    await recoverMessageAddress({ message: issuanceMessage(posted as never, posted.ts as number), signature: posted.walletSignature as Hex }),
    await v.issuerIdentity(),
  )
})

test("scope keys: same wallet + app gives the same key; another app, chain or wallet does not", async () => {
  const a = await KeyVault.fromWallet(wallet, "kendra-watch")
  const b = await KeyVault.fromWallet(wallet, "kendra-watch")
  const s = scopeRef("profile")
  assert.equal(await a.addressOf(s), await b.addressOf(s))
  assert.notEqual(await a.addressOf(s), await (await KeyVault.fromWallet(wallet, "sketch")).addressOf(s))
  assert.notEqual(await a.addressOf(s), await (await KeyVault.fromWallet(wallet, "kendra-watch", { chainId: 1 })).addressOf(s))
  assert.notEqual(await a.addressOf(s), await (await KeyVault.fromWallet(otherWallet, "kendra-watch")).addressOf(s))
  assert.notEqual(await a.addressOf(s), wallet.account.address)
})

test("record keys are random per record: no counter to reuse after expiry or collide across devices (K7, K8)", async () => {
  const v = await KeyVault.fromWallet(wallet, "x")
  const keys = await Promise.all(Array.from({ length: 200 }, () => v.newRecord()))
  assert.equal(new Set(keys.map((k) => k.address)).size, 200)
  assert.equal(new Set(keys.map((k) => k.ref.id)).size, 200)
})

test("tags: a second device (same wallet) opens them; another user and tampering do not", async () => {
  const phone = await KeyVault.fromWallet(wallet, "x")
  const laptop = await KeyVault.fromWallet(wallet, "x")
  const stranger = await KeyVault.fromWallet(otherWallet, "x")
  const otherApp = await KeyVault.fromWallet(wallet, "y")
  const rec = await phone.newRecord()
  const scope = await phone.scopeRecord("profile")
  const [r1, r2] = await laptop.openTags([rec.tag, scope.tag])
  assert.deepEqual(r1, rec.ref)
  assert.deepEqual(r2, scopeRef("profile"))
  assert.equal(await laptop.addressOf(r1!), rec.address)
  assert.deepEqual(await stranger.openTags([rec.tag, scope.tag]), [null, null])
  assert.deepEqual(await otherApp.openTags([rec.tag]), [null])
  const flipped = rec.tag.slice(0, 10) + (rec.tag[10] === "A" ? "B" : "A") + rec.tag.slice(11)
  assert.deepEqual(await laptop.openTags([flipped, "garbage", ""]), [null, null, null])
})

test("tags all look alike: same length for records and scopes, fresh every time, even for one scope", async () => {
  const v = await KeyVault.fromWallet(wallet, "x")
  const tags = [...(await Promise.all([v.newRecord(), v.newRecord(), v.scopeRecord("p"), v.scopeRecord("p")])).map((k) => k.tag)]
  assert.equal(new Set(tags.map((t) => t.length)).size, 1)
  assert.equal(tags[0].length, Math.ceil((TAG_BYTES * 4) / 3))
  assert.equal(new Set(tags).size, 4)
})

test("random root mode round-trips through its recovery code", async () => {
  const { vault, recoveryCode } = KeyVault.random("x")
  const back = KeyVault.fromRecoveryCode(recoveryCode, "x")
  const rec = await vault.newRecord()
  assert.deepEqual((await back.openTags([rec.tag]))[0], rec.ref)
  assert.throws(() => KeyVault.fromRecoveryCode("nope", "x"))
})

test("the root is not reachable from outside the vault, and signers cannot sign arbitrary bytes", async () => {
  const v = await KeyVault.fromWallet(wallet, "x")
  assert.deepEqual(Object.keys(v).sort(), ["app", "mode"])
  const signer = await v.signer((await v.newRecord()).ref)
  assert.deepEqual(Object.keys(signer).sort(), ["address", "signEnvelope", "signProof"])
})

const attrs = { kind: "stock", district: "pune", count: i32(3), price: dec("12.50"), block: u64(123n) }

test("envelope: signed by S, padded, verifies against the same attributes and through the wire format", async () => {
  const v = await KeyVault.fromWallet(wallet, "kendra-watch")
  const k = await v.newRecord()
  const signer = await v.signer(k.ref)
  const sealed = await sealEnvelope({ signer, app: "kendra-watch", payload: enc.encode("hello"), contentType: "text/plain", attributes: attrs, expSeconds: 86400 })
  assert.equal(sealed.payload.length, 512)
  const env = parseEnvelope(sealed.payload)
  assert.equal(await envelopeSigner(env, attrs), k.address)
  assert.equal(await envelopeSigner(env, fromWire(toWire(attrs))), k.address)
})

test("R1: changed data, attributes, expiry, app or encryption flag no longer recover to S", async () => {
  const v = await KeyVault.fromWallet(wallet, "kendra-watch")
  const k = await v.newRecord()
  const { envelope } = await sealEnvelope({ signer: await v.signer(k.ref), app: "kendra-watch", payload: enc.encode("hello"), contentType: "text/plain", attributes: attrs, expSeconds: 86400 })
  assert.notEqual(await envelopeSigner({ ...envelope, data: btoa("HELLO") }, attrs), k.address)
  assert.notEqual(await envelopeSigner(envelope, { ...attrs, count: i32(4) }), k.address)
  assert.notEqual(await envelopeSigner({ ...envelope, exp: 3600 }, attrs), k.address)
  assert.notEqual(await envelopeSigner({ ...envelope, app: "other" }, attrs), k.address)
  assert.notEqual(await envelopeSigner({ ...envelope, enc: 1 }, attrs), k.address)
})

test("A6: encrypted payloads open only for their owner; the same size bucket as plaintext", async () => {
  const mine = await KeyVault.fromWallet(wallet, "x")
  const theirs = await KeyVault.fromWallet(otherWallet, "x")
  const k = await mine.newRecord()
  const ct = await mine.encrypt(k.ref, enc.encode("prescription refill"))
  assert.equal(new TextDecoder().decode(await mine.decrypt(k.ref, ct)), "prescription refill")
  await assert.rejects(theirs.decrypt(k.ref, ct))
  await assert.rejects(mine.decrypt((await mine.newRecord()).ref, ct))
  const plain = await sealEnvelope({ signer: await mine.signer(k.ref), app: "x", payload: enc.encode("prescription refill"), contentType: "text/plain", expSeconds: 3600 })
  const sealed = await sealEnvelope({ signer: await mine.signer(k.ref), app: "x", payload: ct, contentType: "text/plain", expSeconds: 3600, encrypted: true })
  assert.equal(plain.payload.length, sealed.payload.length)
  assert.equal(sealed.envelope.enc, 1)
})

test("canonical attributes ignore key order and value spelling", () => {
  assert.equal(canonicalAttributes({ a: 1, b: "x" }), canonicalAttributes({ b: "x", a: i32(1) }))
  assert.equal(canonicalAttributes({ p: dec("1.50") }), canonicalAttributes({ p: dec("1.5") }))
})

test("F1: expiry rounds up to a bucket", () => {
  assert.equal(expiryBucket(60), 3600)
  assert.equal(expiryBucket(37 * 86400), 7_776_000)
  assert.throws(() => expiryBucket(200 * 86400))
})

test("F2: padding hides the size within a bucket; oversized records are refused", async () => {
  const v = KeyVault.random("x").vault
  const seal = async (n: number) =>
    sealEnvelope({ signer: await v.signer((await v.newRecord()).ref), app: "x", payload: new Uint8Array(n), contentType: "text/plain", expSeconds: 3600 })
  assert.equal((await seal(1)).payload.length, (await seal(20)).payload.length)
  assert.equal((await seal(500)).payload.length, 1024)
  await assert.rejects(seal(20_000), /largest Arkognito record/)
})

test("F3: check() flags a timestamp attribute and a 6-decimal coordinate", () => {
  const w = checkRecord({
    attributes: { createdAt: i32(1_760_000_000), lat: dec("18.520430"), lng: dec("73.8567"), district: "pune" },
    expires: ExpirationTime.fromHours(2),
  })
  const codes = w.map((x) => `${x.code}:${x.attribute ?? ""}`)
  assert.ok(codes.includes("timestamp:createdAt"), codes.join())
  assert.ok(codes.includes("precise-location:lat"), codes.join())
  assert.ok(!codes.includes("precise-location:lng"), codes.join())
  assert.ok(codes.includes("expiry-rounded:"), codes.join())
  assert.equal(checkRecord({ attributes: { district: "pune", kind: "stock" }, expires: 86400 }).length, 0)
})

test("F3: coarse helpers produce values check() accepts", () => {
  assert.equal(coarse.day(Date.UTC(2026, 9, 9, 13, 5)), "2026-10-09")
  assert.equal(coarse.hour(Date.UTC(2026, 9, 9, 13, 5)), "2026-10-09T13")
  assert.equal(coarse.geo(18.520430), "18.52")
  assert.equal(coarse.bucket(37, 10), 30)
  assert.equal(checkRecord({ attributes: { day: coarse.day(Date.now()), lat: dec(coarse.geo(18.52043)) } }).length, 0)
})

test("F3: rarity check warns when fewer than k records share the attribute values", () => {
  const existing = [
    ...Array.from({ length: 6 }, () => ({ attributes: { kind: { value: "stock" }, district: { value: "pune" } } })),
    { attributes: { kind: { value: "stock" }, district: { value: "tiny-village" } } },
  ]
  assert.equal(checkRarity({ project: "p", vtag: "t", kind: "stock", district: "pune" }, existing, 5).length, 0)
  const w = checkRarity({ kind: "stock", district: "tiny-village" }, existing, 5)
  assert.equal(w[0]?.code, "rare-combination")
  assert.equal(checkRarity({ project: "p" }, existing, 5).length, 0)
})

test("D4: ownership proof binds challenge, verifier and deadline", async () => {
  const v = KeyVault.random("x").vault
  const k = await v.newRecord()
  const signer = await v.signer(k.ref)
  const entityKey = `0x${"ab".repeat(32)}` as const
  const fake = { getEntity: async () => ({ owner: k.address }) } as never
  const proof = await signOwnershipProof(signer, { entityKey, challenge: "c1", verifier: "desk" })
  assert.deepEqual(await verifyOwnershipProof(proof, { challenge: "c1", verifier: "desk", client: fake }), { ok: true })
  assert.equal((await verifyOwnershipProof(proof, { challenge: "c2", verifier: "desk", client: fake })).ok, false)
  assert.equal((await verifyOwnershipProof(proof, { challenge: "c1", verifier: "someone", client: fake })).ok, false)
  assert.equal((await verifyOwnershipProof(proof, { challenge: "c1", verifier: "desk", client: fake, now: proof.expiresAt + 1 })).ok, false)
  assert.equal((await verifyOwnershipProof({ ...proof, expiresAt: proof.expiresAt + 3600 }, { challenge: "c1", verifier: "desk", client: fake })).ok, false)
  const notOwner = { getEntity: async () => ({ owner: "0x0000000000000000000000000000000000000001" }) } as never
  assert.equal((await verifyOwnershipProof(proof, { challenge: "c1", verifier: "desk", client: notOwner })).ok, false)
})

test("R7: OHTTP round trip; the relay sees only ciphertext and the gateway's answer comes back intact", async () => {
  const gateway = await OhttpGateway.fromSeed(crypto.getRandomValues(new Uint8Array(32)))
  const again = await OhttpGateway.fromSeed(new Uint8Array(32).fill(7))
  assert.equal(again.publicKey, (await OhttpGateway.fromSeed(new Uint8Array(32).fill(7))).publicKey, "gateway key is stable for a seed")
  const seenByRelay: Uint8Array[] = []
  const relayFetch = (async (_url: string, init: RequestInit) => {
    const body = new Uint8Array(init.body as ArrayBuffer)
    seenByRelay.push(body)
    const opened = await gateway.open(body)
    const answer = { status: 202, body: { echo: opened.request.path, id: "secret-id-123" } }
    return new Response(Buffer.from(await opened.seal(answer)), { status: 200 })
  }) as typeof fetch
  const res = await ohttpCall("http://relay", "http://relayer", gateway.publicKey as Hex, { method: "POST", path: "/v1/records", body: { owner: "0xabc", envelope: "private" } }, relayFetch)
  assert.deepEqual(res, { status: 202, body: { echo: "/v1/records", id: "secret-id-123" } })
  const raw = Buffer.from(seenByRelay[0]).toString("latin1")
  assert.ok(!raw.includes("/v1/records") && !raw.includes("private") && !raw.includes("0xabc"), "relay must not see the request")
  const wrong = await OhttpGateway.fromSeed(crypto.getRandomValues(new Uint8Array(32)))
  await assert.rejects(ohttpCall("http://relay", "http://relayer", wrong.publicKey as Hex, { method: "GET", path: "/v1/info" }, relayFetch))
})

test("T2: tokens are spent oldest first and never before they reach the minimum age", async () => {
  const { TokenWallet, memoryStore, epochOf } = await import("../src/index.ts")
  const store = memoryStore()
  const now = Date.now()
  const day = epochOf()
  store.save([
    { app: "a", epoch: day, nonce: "0x02", signature: "s2", issuedAt: now },
    { app: "a", epoch: day, nonce: "0x01", signature: "s1", issuedAt: now - 1000 },
    { app: "b", epoch: day, nonce: "0x03", signature: "s3", issuedAt: now - 5000 },
  ])
  const tw = new TokenWallet({ wallet: {} as never, reader: {} as never, issuer: "0x0000000000000000000000000000000000000001", issuerUrl: "", store, minAgeMs: 1400 })
  const info = { tokensRequired: true } as never
  const t0 = Date.now()
  const first = await tw.source().take("a", info)
  const waited = Date.now() - t0
  assert.equal(first?.nonce, "0x01", "oldest token first")
  assert.ok(waited >= 350, `waited ${waited} ms for the token to reach 1.4 s of age`)
  assert.equal(tw.available("a"), 1)
  assert.equal(tw.available("b"), 1)
})
