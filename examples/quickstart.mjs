// Quickstart: write one private record through a relayer and find it again.
// Run a relayer first (npm run relayer), then: node examples/quickstart.mjs
// Uses a throwaway wallet: it needs no funds, because the relayer pays for the write.
import { createPublicClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { createPrivateClient } from "arkognito"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const relayer = process.env.RELAYER_URL ?? "http://localhost:8787"
const app = `quickstart-${Math.random().toString(36).slice(2, 8)}`
const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })

const ark = await createPrivateClient({ app, wallet, relayers: [relayer], delayMs: [0, 0] })
console.log(`writing one record for app "${app}" through ${relayer} (it waits for a batch)…`)

const { entityKey, owner, batchSize } = await ark.createEntity({
  payload: jsonToPayload({ hello: "arkiv" }),
  contentType: "application/json",
  attributes: { kind: "greeting" },
  expires: ExpirationTime.fromHours(1),
})
console.log(`written: ${entityKey}\n  owner ${owner} (one-time), batch of ${batchSize}`)

const mine = await ark.myEntities()
console.log(`myEntities(): ${mine.length} record(s), first says ${JSON.stringify(mine[0]?.toJson())}`)

const reader = createPublicClient({ chain: tiramisu, transport: http() })
const { entities } = await reader.select({ key: true }).where(eq("project", app)).ownedBy(wallet.account.address).fetch()
console.log(`owner query on your wallet: ${entities.length} record(s)`)

if (mine.length !== 1 || mine[0].key !== entityKey || entities.length !== 0) {
  console.error("quickstart FAILED")
  process.exit(1)
}
console.log("quickstart OK")
process.exit(0)
