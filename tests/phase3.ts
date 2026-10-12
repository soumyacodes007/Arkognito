// Phase 3 test (PRD §8):
//  - Two relayers with heartbeats; clients discover them from Arkiv.
//  - Kill relay-1 while records wait in its queue: every record still lands through relay-2, none twice per S.
//  - 5 synthetic users send 50 records; an outside observer with only chain data tries to group
//    records by person. Target: no better than random guessing within each batch.
import { createPrivateClient, discoverRelayers, heartbeatRelayers } from "arkognito"
import { eq } from "@arkiv-network/sdk/query"
import { attack, observe, precision } from "./observer"
import { check, done, localRelayer, makeUser, publicClient, runId, sleep } from "./helpers"

const app = "arkognito-phase3"
const project = `arkognito-test-${runId}`
console.log(`run ${runId}, project ${project}`)

const batchEnv = { MIN_BATCH: "5", MAX_WAIT_MS: "30000", MIN_INTERVAL_BLOCKS: "5", HEARTBEAT: "on", HEARTBEAT_EVERY_MS: "60000" }
// MIN_BATCH 6 with 5 writers: relay-1 never flushes, so killing it loses the queue (the crash-after-write case is in tests/edge-cases.ts).
const relay1 = await localRelayer("relay-1", "RELAYER_1_PRIVATE_KEY", 8801, { ...batchEnv, MIN_BATCH: "6", MAX_WAIT_MS: "600000" })
const relay2 = await localRelayer("relay-2", "RELAYER_2_PRIVATE_KEY", 8802, batchEnv)

// ---- discovery (R8) ------------------------------------------------------------------------
const live = await discoverRelayers(publicClient)
check("both relayers discovered from heartbeat entities", [relay1.url, relay2.url].every((u) => live.some((l) => l.url === u)),
  live.map((l) => `${l.url}=${l.address.slice(0, 8)}`).join(", "))

// ---- kill relay-1 with records in its queue (R3, R8) ------------------------------------
const users = await Promise.all([0, 1, 2, 3, 4].map(() => makeUser(app)))
const killClients = await Promise.all(
  users.map((u) =>
    createPrivateClient({
      app, project, vault: u.vault, publicClient, relayers: [relay1.url, relay2.url],
      delayMs: [0, 0], pollMs: 1000, inclusionTimeoutMs: 20_000,
    }),
  ),
)
const killWrites = killClients.map((c, i) =>
  c.createEntity({ payload: new TextEncoder().encode(`kill-test ${i}`), contentType: "text/plain", attributes: { phase: "kill" }, expires: 3600 }),
)
for (let i = 0; i < 60 && relay1.batcher.queue.length < 5; i++) await sleep(1000)
check("relay-1 holds the records in its queue (k=6, long max wait)", relay1.batcher.queue.length === 5, `${relay1.batcher.queue.length} queued`)
await relay1.close()
const killedAt = Date.now()
console.log("relay-1 killed")
const killResults = await Promise.all(killWrites)
check("all 5 records landed after relay-1 died", killResults.length === 5)
check("all of them went through relay-2", killResults.every((r) => r.relayer === relay2.url))
const perOwner: number[] = []
for (const r of killResults) {
  const { entities } = await publicClient.select({ key: true }).where(eq("project", project)).ownedBy(r.owner).fetch()
  perOwner.push(entities.length)
}
check("each S owns exactly one record (nothing written twice)", perOwner.every((n) => n === 1), `records per S: ${perOwner.join(",")}`)

// ---- linkage experiment: 5 users x 10 records with random client delays ------------------
const truth = new Map<string, string>()
const clients = await Promise.all(
  users.map((u) => createPrivateClient({ app, project, vault: u.vault, publicClient, relayers: [relay2.url], delayMs: [0, 15_000], pollMs: 2000 })),
)
const started = Date.now()
const results = await Promise.all(
  clients.map(async (c, u) => {
    const out = []
    for (let i = 0; i < 10; i++) {
      const r = await c.createEntity({
        payload: new TextEncoder().encode(JSON.stringify({ user: "synthetic", n: i, filler: "x".repeat(Math.floor(Math.random() * 60)) })),
        contentType: "application/json",
        attributes: { phase: "linkage" },
        expires: 3600,
      })
      truth.set(r.entityKey.toLowerCase(), `user-${u}`)
      out.push(r)
    }
    return out
  }),
)
const flat = results.flat()
console.log(`50 records in ${Math.round((Date.now() - started) / 1000)} s`)
check("50 linkage records written", flat.length === 50)
const sizes = flat.map((r) => r.batchSize ?? 0)
const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
check("average batch size is at least 4 (k=5, users spread across batches)", avg >= 4, `avg ${avg.toFixed(2)}, sizes ${[...new Set(sizes)].join("/")}`)

const observed = (await observe(publicClient, project)).filter((r) => truth.has(r.key.toLowerCase()))
check("observer sees all 50 records", observed.length === 50)
const byTx = new Map<string, string[]>()
for (const r of observed) byTx.set(r.tx ?? "", [...(byTx.get(r.tx ?? "") ?? []), truth.get(r.key.toLowerCase())!])
const sameUserInBatch = [...byTx.values()].filter((people) => new Set(people).size !== people.length).length
check("B4: no batch holds two records from the same user", sameUserInBatch === 0, `${byTx.size} batches`)
check("every record has its own owner", new Set(observed.map((r) => r.owner.toLowerCase())).size === 50)
check("all records share one creator (the relayer)", new Set(observed.map((r) => r.creator.toLowerCase())).size === 1)
check("all records have the same padded size", new Set(observed.map((r) => r.size)).size === 1, `${[...new Set(observed.map((r) => r.size))].join("/")} bytes`)

const pairs = attack(observed)
const p = precision(pairs, truth)
const people = new Set(truth.values()).size
const chance = 1 / people
check(`observer precision is near chance (1/${people} = ${chance.toFixed(2)})`, p <= chance + 0.15, `precision ${p.toFixed(3)} on ${pairs.length} guessed pairs`)

// Baseline without Arkognito: one owner query per wallet links everything.
console.log(`INFO  without Arkognito an owner query links 100% of each user's records; with Arkognito the observer scores ${(p * 100).toFixed(1)}%`)

// ---- heartbeat expiry of the dead relayer --------------------------------------------------
const waitMs = 320_000 - (Date.now() - killedAt)
if (waitMs > 0) {
  console.log(`waiting ${Math.round(waitMs / 1000)} s for relay-1's heartbeat to expire`)
  await sleep(waitMs)
}
const after = await heartbeatRelayers(publicClient)
check("dead relay-1 dropped out of discovery on its own (heartbeat expired)", !after.some((l) => l.url === relay1.url))
check("relay-2 is still listed", after.some((l) => l.url === relay2.url))

await relay2.close()
done()
process.exit()
