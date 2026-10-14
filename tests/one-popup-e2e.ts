// End to end against live relayers: how many wallet prompts does connecting cost?
//
//   session 1 (new device):      2 derivation prompts, 0 issuance prompts
//   session 2 (returning user):  1 derivation prompt,  0 issuance prompts
//
// Also checks that the issuer is asked by the derived identity, never the wallet, and that a write
// lands and is found again from the second session.
//
//   RELAYERS=https://a,https://b npx tsx --conditions=arkognito-source tests/one-popup-e2e.ts
import assert from "node:assert/strict"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { type ArkivReader, createPrivateClient, memoryStore } from "../packages/sdk/src/index.ts"

const relayers = (process.env.RELAYERS ?? "https://relay-1-production-80f5.up.railway.app,https://relay-2-production-6f0f.up.railway.app").split(",")
const app = `popup-e2e-${Date.now().toString(36)}`
const reader = createPublicClient({ chain: tiramisu, transport: http() }) as unknown as ArkivReader
const userWallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })

const prompts = { typed: 0, message: 0 }
const wallet = {
  account: userWallet.account,
  signTypedData: (a: never) => (prompts.typed++, userWallet.signTypedData(a)),
  signMessage: (a: never) => (prompts.message++, userWallet.signMessage(a)),
}

// What would be localStorage on a real device, shared by both sessions.
const checks = new Map<string, string>()
const determinismStore = { get: (k: string) => checks.get(k), set: (k: string, v: string) => void checks.set(k, v) }
const tokenStore = memoryStore()

const issuance: Record<string, unknown>[] = []
const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith("/v1/tokens/issue")) issuance.push(JSON.parse(String(init?.body)))
  return fetch(input, init)
}) as typeof fetch

const t0 = Date.now()
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
const common = { app, relayers, publicClient: reader, isolateKeys: false, determinismStore, tokenStore, fetch: fetchSpy, delayMs: [0, 0] as [number, number] }

log(`app ${app}, user ${userWallet.account.address}`)

// ---- session 1: first visit on this device -----------------------------------------------------
const s1 = await createPrivateClient({ ...common, wallet })
log(`session 1 connected: ${prompts.typed} typed-data prompts, ${prompts.message} message prompts`)
assert.equal(prompts.typed, 2, "first visit: two derivation prompts (determinism check)")
assert.equal(prompts.message, 0, "no issuance prompt")

const record = await s1.createEntity({
  payload: new TextEncoder().encode(JSON.stringify({ note: "synthetic one-popup e2e record" })),
  contentType: "application/json",
  attributes: { kind: "e2e" },
  expires: 3600,
})
log(`write landed: ${record.entityKey} owner ${record.owner} via ${record.relayer} (batch of ${record.batchSize ?? "?"})`)
assert.equal(prompts.message, 0, "writing opened no wallet prompt")
assert.equal(prompts.typed, 2)

assert.ok(issuance.length >= 1, "tokens were requested")
const identity = await s1.vault.issuerIdentity()
for (const req of issuance) {
  assert.equal(String(req.wallet).toLowerCase(), identity.toLowerCase(), "issuer saw the derived identity")
  assert.notEqual(String(req.wallet).toLowerCase(), userWallet.account.address.toLowerCase(), "issuer never saw the wallet")
}
log(`issuer was asked ${issuance.length}x by ${identity}, not by the wallet`)
const left = tokenStore.load().length
log(`tokens left in the store: ${left}`)

// ---- session 2: same device, page reloaded -----------------------------------------------------
prompts.typed = 0
prompts.message = 0
const issuedBefore = issuance.length
const s2 = await createPrivateClient({ ...common, wallet })
log(`session 2 connected: ${prompts.typed} typed-data prompts, ${prompts.message} message prompts`)
assert.equal(prompts.typed, 1, "returning user: one derivation prompt")
assert.equal(prompts.message, 0)
assert.equal(await s2.vault.issuerIdentity(), identity, "same identity across sessions")

const mine = await s2.myEntities()
log(`session 2 found ${mine.length} record(s): ${mine.map((r) => r.entityKey).join(", ")}`)
assert.ok(mine.some((r) => r.entityKey === record.entityKey), "the record from session 1 is found")
assert.equal(mine.find((r) => r.entityKey === record.entityKey)?.toJson().note, "synthetic one-popup e2e record")
assert.equal(prompts.typed + prompts.message, 1, "reading opened no further prompt")
if (left > 0) assert.equal(issuance.length, issuedBefore, "tokens left over, so no new issuance")
log(`session 2 issuance requests: ${issuance.length - issuedBefore} (store had ${left} tokens)`)

log("PASS: first visit 2 prompts, returning visit 1 prompt, issuer never sees the wallet")
process.exit(0)
