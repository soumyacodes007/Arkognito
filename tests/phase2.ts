// Phase 2 test (PRD §8):
//  - A user creates 10 records; myEntities() returns exactly those 10 from ~200 records by 5 users.
//  - A tampered payload is rejected by the reader.
//  - A relayer that transfers to the wrong owner is detected.
//  - proveOwnership() proves one record to a verifier; another user cannot.
import { createPrivateClient, verifyOwnershipProof, verifyRecord } from "arkognito"
import { eq } from "@arkiv-network/sdk/query"
import { check, done, localRelayer, makeUser, publicClient, rawSubmit, runId, waitAll } from "./helpers"

const app = "arkognito-phase2"
const project = `arkognito-test-${runId}`
console.log(`run ${runId}, project ${project}`)

const good = await localRelayer("good", "RELAYER_1_PRIVATE_KEY", 8791, { MAX_BATCH: "40" })
const clientOpts = { app, project, relayers: [good.url], publicClient, delayMs: [0, 0] as [number, number], pollMs: 1000 }

// ---- 4 background users write 190 records -----------------------------------------------
const others = await Promise.all([1, 2, 3, 4].map(() => makeUser(app)))
const counts = [48, 48, 47, 47]
const ids: string[] = []
for (const [u, user] of others.entries()) {
  for (let i = 0; i < counts[u]; i++) ids.push(await rawSubmit(good.url, user.vault, i, app, { project, kind: "noise" }))
}
console.log(`submitted ${ids.length} background records`)

// ---- user A writes 10 records through the real client ------------------------------------
const alice = await makeUser(app)
const ark = await createPrivateClient({ ...clientOpts, vault: alice.vault })
const mineCreated: string[] = []
for (let i = 0; i < 10; i++) {
  const r = await ark.createEntity({
    payload: new TextEncoder().encode(JSON.stringify({ note: `alice ${i}` })),
    contentType: "application/json",
    attributes: { kind: "note" },
    expires: 3600,
  })
  mineCreated.push(r.entityKey.toLowerCase())
}
check("A's 10 writes landed with distinct owners", new Set(mineCreated).size === 10)

const bg = await waitAll(good.url, ids)
const bgWritten = [...bg.values()].filter((s) => s.state === "written").length
check("190 background records written", bgWritten === 190, `${bgWritten} written, batch sizes ${[...new Set([...bg.values()].map((s) => s.batchSize))].join("/")}`)

let total = 0
for await (const _ of publicClient.select({ key: true }).where(eq("project", project)).limit(200)) total++
check("project holds 200 records from 5 users", total === 200, `${total}`)

const mine = await ark.myEntities()
const found = new Set(mine.map((m) => m.entityKey.toLowerCase()))
check("myEntities() returns exactly A's 10", found.size === 10 && mineCreated.every((k) => found.has(k)), `${found.size} found`)
check("each of A's records decodes to its own payload",
  mine.every((m) => JSON.parse(new TextDecoder().decode(m.data)).note.startsWith("alice")))
check("every A record has a different owner, none is A's wallet",
  new Set(mine.map((m) => m.owner.toLowerCase())).size === 10 &&
    mine.every((m) => m.owner.toLowerCase() !== alice.wallet.account.address.toLowerCase()))
const ownedByWallet = await publicClient.select({ key: true }).where(eq("project", project)).ownedBy(alice.wallet.account.address).fetch()
check("owner query on A's real wallet finds nothing", ownedByWallet.entities.length === 0)

// A fresh client instance (same wallet, "new device") finds the same 10 by re-derivation.
const ark2 = await createPrivateClient({ ...clientOpts, vault: alice.vault })
check("a second session re-derives the same 10", (await ark2.myEntities()).length === 10)

const bob = await createPrivateClient({ ...clientOpts, vault: others[0].vault })
check("user B's myEntities() returns B's 48", (await bob.myEntities()).length === 48)

// ---- proveOwnership ----------------------------------------------------------------------
const target = mine[3].entityKey
const proof = await ark.proveOwnership(target, { challenge: "nonce-123", verifier: "kendra-desk" })
const ok = await verifyOwnershipProof(proof, { challenge: "nonce-123", verifier: "kendra-desk", client: publicClient })
check("proveOwnership() verifies for the right verifier and challenge", ok.ok, JSON.stringify(ok))
let bobCould = true
try {
  await bob.proveOwnership(target, { challenge: "nonce-123", verifier: "kendra-desk" })
} catch {
  bobCould = false
}
check("B cannot prove A's record", !bobCould)

// ---- misbehaving relayers (R1, R2) -------------------------------------------------------
for (const evil of ["tamper", "wrong-owner"] as const) {
  const bad = await localRelayer(`evil-${evil}`, "RELAYER_2_PRIVATE_KEY", 8792, { ARKOGNITO_EVIL: evil })
  const c = await createPrivateClient({ ...clientOpts, vault: alice.vault, relayers: [bad.url, good.url] })
  const r = await c.createEntity({ payload: new TextEncoder().encode(`via ${evil}`), contentType: "text/plain", attributes: { kind: "note" }, expires: 3600 })
  const badState = c.relayers().find((x) => x.url === bad.url)
  check(`${evil}: client detected the bad relayer and marked it`, badState?.bad === true)
  check(`${evil}: record still landed through the honest relayer`, r.relayer === good.url)
  const evilRecords = await publicClient
    .select({ key: true, owner: true, creator: true, payload: true, attributes: true, createdAt: true, expiresAt: true })
    .where(eq("project", project))
    .createdBy(((await (await fetch(`${bad.url}/v1/info`)).json()) as { address: `0x${string}` }).address)
    .fetch()
  const verdicts = await Promise.all(evilRecords.entities.map((e) => verifyRecord(e)))
  check(`${evil}: reader rejects everything the bad relayer wrote`, verdicts.length > 0 && verdicts.every((v) => !v.ok), verdicts.map((v) => (v.ok ? "ok" : v.reason)).join(" / "))
  await bad.close()
}

check("A's myEntities() now has 12 (10 + 2 retried via the honest relayer)", (await ark.myEntities()).length === 12)

await good.close()
done()
process.exit()
