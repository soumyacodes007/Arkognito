// Repro for the SDK paging bug: a page-through that does not pin a block breaks as soon as a new
// block lands between pages. Read-only; uses the public RPC without an access key.
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { http } from "viem"

const client = createPublicClient({ chain: tiramisu, transport: http() })
const project = process.argv[2] ?? "veil-demo-sketch"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitForNewBlock(after: bigint) {
  while ((await client.getBlockNumber()) <= after) await sleep(500)
}
const short = (e: unknown) => String((e as Error).message).replace(/\s+/g, " ").slice(0, 160)

// 1. fetch() then next() after a block lands
const first = await client.select({ key: true }).where(eq("project", project)).limit(5).fetch()
console.log(`page 1: ${first.entities.length} entities at block ${first.blockNumber}, more: ${first.hasNextPage()}`)
await waitForNewBlock(first.blockNumber)
try {
  const second = await first.next()
  console.log(`page 2 after a new block: OK (${second.entities.length} entities at block ${second.blockNumber})`)
} catch (e) {
  console.log(`page 2 after a new block: FAILS -> ${short(e)}`)
}

// 2. the SDK's own async iterator with a consumer that takes a moment per page
let seen = 0
try {
  for await (const _ of client.select({ key: true }).where(eq("project", project)).limit(5)) {
    if (++seen % 5 === 0) await sleep(2500) // e.g. rendering or a request per item
  }
  console.log(`for await with a slow consumer: OK (${seen} entities)`)
} catch (e) {
  console.log(`for await with a slow consumer: FAILS after ${seen} entities -> ${short(e)}`)
}

// 3. workaround: pin the walk to one block
const head = await client.getBlockNumber()
seen = 0
for await (const _ of client.select({ key: true }).where(eq("project", project)).limit(5).atBlock(head)) {
  if (++seen % 5 === 0) await sleep(2500)
}
console.log(`for await pinned with atBlock(${head}): OK (${seen} entities)`)
