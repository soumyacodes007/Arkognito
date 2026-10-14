// Attribute-name charset on Tiramisu, checked against the Arkiv skills' guidance.
// For each name: what the SDK's validator says, whether the node accepts a create, and whether a
// query naming it is accepted. Also: does one bad name revert a whole executeBatch?
// Uses DEMO_USER_PRIVATE_KEY (not a relayer wallet). Records expire after 2 minutes.
import { ExpirationTime, isValidAttributeName } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
import { publicClient, walletFor } from "./lib"

const w = walletFor("DEMO_USER_PRIVATE_KEY")
const run = crypto.randomUUID().slice(0, 8)
const names = ["kind", "snake_case_name", "dot.name", "dash-name", "a1", "Kind", "camelCase", "snake_Case", "UPPER", "x"]
const make = (name: string) => ({
  payload: new Uint8Array(),
  contentType: "application/octet-stream",
  attributes: { project: `attr-probe-${run}`, [name]: "v" },
  expires: ExpirationTime.fromMinutes(2),
})
const short = (e: unknown) => String((e as Error).message).replace(/\s+/g, " ").slice(0, 150)

console.log(`run ${run}, SDK 0.8.1, chain ${await publicClient.getChainId()}, head ${await publicClient.getBlockNumber()}`)
console.log("name             | SDK valid | node create | query by name")
for (const name of names) {
  let create = "accepted"
  try {
    await w.createEntity(make(name))
  } catch (e) {
    create = `REJECTED: ${short(e)}`
  }
  let query = "accepted"
  try {
    await publicClient.select({ key: true }).where(eq(name, "v")).limit(1).fetch()
  } catch (e) {
    query = `REJECTED: ${short(e)}`
  }
  console.log(`${name.padEnd(16)} | ${String(isValidAttributeName(name)).padEnd(9)} | ${create.slice(0, 60).padEnd(11)} | ${query.slice(0, 60)}`)
}

// One bad name in a batch: is the whole batch reverted?
let batch = "applied"
try {
  await w.executeBatch({ creates: [make("good_name"), make("badName")] })
} catch (e) {
  batch = `reverted: ${short(e)}`
}
const { entities } = await publicClient.select({ key: true }).where(eq("project", `attr-probe-${run}`), eq("good_name", "v")).fetch()
console.log(`executeBatch [good_name, badName]: ${batch}`)
console.log(`  good_name record written anyway: ${entities.length > 0}`)
