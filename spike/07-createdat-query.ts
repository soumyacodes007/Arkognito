// Friction repro: the API reference says $createdAt is queryable; SDK 0.8.1 refuses to build such a
// query. Does the node accept it through the raw query method?
import { eq } from "@arkiv-network/sdk/query"
import { publicClient } from "./lib"

const head = await publicClient.getBlockNumber()
try {
  await publicClient.select({ key: true }).where(eq("$createdAt" as never, 1n as never)).fetch()
  console.log("SDK builder accepted $createdAt")
} catch (e) {
  console.log(`SDK builder: ${(e as Error).message.slice(0, 140)}`)
}
try {
  const r = await publicClient.query(`project = str('arkognito-demo-sketch') AND $createdAt <= u64(${head})`, { select: { key: true }, limit: 5 } as never)
  console.log(`raw query accepted: ${JSON.stringify(r).slice(0, 200)}`)
} catch (e) {
  console.log(`raw query: ${(e as Error).message.slice(0, 200)}`)
}
