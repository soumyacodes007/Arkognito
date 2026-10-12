// Spike test 5 (edge case A6): after a record expires, is its payload still readable?
// Checks the entity API, queries, past-block queries, and the raw transaction calldata.
import { ExpirationTime, NoEntityFoundError, jsonToPayload } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
import { stringToHex } from "viem"
import { PROJECT, check, publicClient, sleep, walletFor } from "./lib"

const relayer = walletFor("RELAYER_1_PRIVATE_KEY")
const runId = crypto.randomUUID().slice(0, 8)
const marker = `arkognito-expiry-marker-${runId}`

const { entityKey, txHash, expiresAt } = await relayer.createEntity({
  payload: jsonToPayload({ marker }),
  contentType: "application/json",
  attributes: { project: PROJECT, kind: "spike-expiry", run: runId },
  expires: ExpirationTime.fromBlocks(10),
})
const createdBlock = (await publicClient.getTransactionReceipt({ hash: txHash })).blockNumber
console.log(`created ${entityKey} in block ${createdBlock}, expires at block ${expiresAt}`)

check("5a readable before expiry", (await publicClient.getEntity(entityKey)).toJson().marker === marker)

while ((await publicClient.getBlockNumber()) <= expiresAt + 1n) await sleep(2000)
console.log(`head is now ${await publicClient.getBlockNumber()}`)

let gone = false
try {
  await publicClient.getEntity(entityKey)
} catch (e) {
  gone = e instanceof NoEntityFoundError || /no entity|not found/i.test((e as Error).message)
}
check("5b getEntity fails after expiry", gone)

const q = await publicClient.select({ key: true }).where(eq("project", PROJECT), eq("run", runId)).fetch()
check("5c query no longer returns it", q.entities.length === 0)

let pastVisible = false
try {
  const past = await publicClient
    .select({ key: true, payload: true })
    .where(eq("project", PROJECT), eq("run", runId))
    .atBlock(createdBlock)
    .fetch()
  pastVisible = past.entities.length === 1
} catch (e) {
  console.log(`atBlock query error: ${(e as Error).message.slice(0, 120)}`)
}
console.log(`INFO  atBlock(${createdBlock}) query still returns the record: ${pastVisible}`)

const tx = await publicClient.getTransaction({ hash: txHash })
const inCalldata = tx.input.toLowerCase().includes(stringToHex(marker).slice(2).toLowerCase())
console.log(`INFO  payload marker readable in the create tx calldata after expiry: ${inCalldata}`)
check("5d result recorded (A6: expiry limits queries, not history)", true,
  inCalldata ? "payload stays in tx history: sensitive data must be encrypted" : "payload not found in calldata")

