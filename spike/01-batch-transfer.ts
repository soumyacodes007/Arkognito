// Spike tests 1-3.
// 1. One executeBatch with 5 creates + 5 ownership transfers to predicted keys:
//    $creator = relayer, $owner = S.
// 2. Two batches predicted from the same entity nonce (as if both were in flight):
//    the second one must fail or mispredict (proves R5 matters).
// 3. ownedBy(S) and createdBy(relayer) queries work.
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { PROJECT, check, publicClient, walletFor } from "./lib"

const relayer = walletFor("RELAYER_1_PRIVATE_KEY")
const relayerAddr = relayer.account.address
const runId = crypto.randomUUID().slice(0, 8)
const freshOwner = () => privateKeyToAccount(generatePrivateKey()).address

function creates(n: number, salts: bigint[]) {
  return Array.from({ length: n }, (_, i) => ({
    payload: jsonToPayload({ spike: runId, i }),
    contentType: "application/json",
    attributes: { project: PROJECT, kind: "spike", run: runId },
    expires: ExpirationTime.fromMinutes(10),
    salt: salts[i],
  }))
}

// ---- Test 1 -----------------------------------------------------------------
console.log(`run ${runId}, relayer ${relayerAddr}`)
const owners = Array.from({ length: 5 }, freshOwner)
const predicted = await publicClient.predictEntityKeys({ owner: relayerAddr, count: 5 })
const t0 = Date.now()
const res = await relayer.executeBatch({
  creates: creates(5, predicted.map((p) => p.salt)),
  ownershipChanges: predicted.map((p, i) => ({ entityKey: p.key, newOwner: owners[i] })),
})
console.log(`batch tx ${res.txHash} in ${Date.now() - t0} ms`)
check("1a predicted keys match minted keys",
  res.createdEntities.every((k, i) => k.toLowerCase() === predicted[i].key.toLowerCase()))

const fetched = await Promise.all(predicted.map((p) => publicClient.getEntity(p.key)))
check("1b $creator = relayer on all 5",
  fetched.every((e) => e.creator?.toLowerCase() === relayerAddr.toLowerCase()),
  fetched.map((e) => e.creator).join(","))
check("1c $owner = S on all 5",
  fetched.every((e, i) => e.owner?.toLowerCase() === owners[i].toLowerCase()))

// ---- Test 3 -----------------------------------------------------------------
const byOwner = await publicClient.select({ key: true, owner: true }).ownedBy(owners[2]).fetch()
check("3a ownedBy(S) returns exactly that record",
  byOwner.entities.length === 1 && byOwner.entities[0].key.toLowerCase() === predicted[2].key.toLowerCase(),
  `${byOwner.entities.length} result(s)`)
const byCreator = await publicClient
  .select({ key: true, creator: true })
  .where(eq("project", PROJECT), eq("run", runId))
  .createdBy(relayerAddr)
  .fetch()
check("3b createdBy(relayer) + run attribute returns all 5", byCreator.entities.length === 5,
  `${byCreator.entities.length} result(s)`)
const ownedByRelayer = await publicClient
  .select({ key: true })
  .where(eq("project", PROJECT), eq("run", runId))
  .ownedBy(relayerAddr)
  .fetch()
check("3c relayer owns none of them after the batch", ownedByRelayer.entities.length === 0)

// ---- Test 2 -----------------------------------------------------------------
// Both predictions read the same entity nonce, exactly as two in-flight batches would.
const predA = await publicClient.predictEntityKeys({ owner: relayerAddr, count: 2 })
const predB = await publicClient.predictEntityKeys({ owner: relayerAddr, count: 2 })
check("2a both predictions start from the same nonce (keys differ only by salt)", predA[0].key !== predB[0].key)
const ownersA = [freshOwner(), freshOwner()]
const ownersB = [freshOwner(), freshOwner()]
await relayer.executeBatch({
  creates: creates(2, predA.map((p) => p.salt)),
  ownershipChanges: predA.map((p, i) => ({ entityKey: p.key, newOwner: ownersA[i] })),
})
let bError = ""
try {
  await relayer.executeBatch({
    creates: creates(2, predB.map((p) => p.salt)),
    ownershipChanges: predB.map((p, i) => ({ entityKey: p.key, newOwner: ownersB[i] })),
  })
} catch (e) {
  bError = (e as Error).message
}
check("2b second batch with stale prediction reverts", bError !== "", bError.slice(0, 160))
const leaked = await publicClient
  .select({ key: true })
  .where(eq("project", PROJECT), eq("run", runId))
  .ownedBy(relayerAddr)
  .fetch()
check("2c revert is atomic: no record left owned by the relayer", leaked.entities.length === 0,
  `${leaked.entities.length} owned by relayer`)

// Re-predict and resend: the fix the writer queue applies.
const predB2 = await publicClient.predictEntityKeys({ owner: relayerAddr, count: 2 })
const resB2 = await relayer.executeBatch({
  creates: creates(2, predB2.map((p) => p.salt)),
  ownershipChanges: predB2.map((p, i) => ({ entityKey: p.key, newOwner: ownersB[i] })),
})
check("2d re-predict and resend succeeds", resB2.createdEntities.length === 2)

const bal = await publicClient.getBalance({ address: relayerAddr })
console.log(`relayer balance now ${Number(bal) / 1e18} GLM`)
