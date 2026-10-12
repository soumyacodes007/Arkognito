// npm run setup — prepares a self-hosted Arkognito network.
//
// Creates .env from .env.example if needed, fills in any missing wallet keys (relay-1, relay-2,
// issuer) and the issuer seed, then prints each wallet's address and balance so you can fund them
// from the faucet. Private keys are written to .env only, never printed. Safe to run again: it never
// replaces a value that is already set.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createPublicClient, formatEther, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { tiramisu } from "@arkiv-network/sdk/chains"

const ENV = ".env"
const text = existsSync(ENV) ? readFileSync(ENV, "utf8") : readFileSync(".env.example", "utf8")
const lines = text.split(/\r?\n/)
const get = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? ""
function set(k: string, v: string) {
  const i = lines.findIndex((l) => l.startsWith(`${k}=`))
  if (i >= 0) lines[i] = `${k}=${v}`
  else lines.push(`${k}=${v}`)
}

const wallets = [
  { name: "relay-1", prefix: "RELAYER_1", role: "relayer that also runs the token issuer's HTTP API" },
  { name: "relay-2", prefix: "RELAYER_2", role: "second relayer" },
  { name: "issuer", prefix: "ISSUER_WALLET", role: "publishes the daily issuer keys" },
]
const created: string[] = []
for (const w of wallets) {
  if (!get(`${w.prefix}_PRIVATE_KEY`)) {
    const key = generatePrivateKey()
    set(`${w.prefix}_PRIVATE_KEY`, key)
    set(`${w.prefix}_ADDRESS`, privateKeyToAccount(key).address)
    created.push(w.name)
  } else if (!get(`${w.prefix}_ADDRESS`)) {
    set(`${w.prefix}_ADDRESS`, privateKeyToAccount(get(`${w.prefix}_PRIVATE_KEY`) as `0x${string}`).address)
  }
}
if (!/^0x[0-9a-fA-F]{64}$/.test(get("ISSUER_RSA_SEED"))) {
  set("ISSUER_RSA_SEED", `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`)
  created.push("issuer seed")
}
writeFileSync(ENV, lines.join("\n").replace(/\n*$/, "\n"))

const rpc = get("ARKIV_RPC_URL") || "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const client = createPublicClient({ chain: tiramisu, transport: http(rpc) })
console.log(created.length ? `created: ${created.join(", ")} (keys are in .env only)` : "all keys already set")
console.log("\nFund each wallet with Tiramisu GLM: https://hub.arkiv.network/faucet\n")
for (const w of wallets) {
  const address = get(`${w.prefix}_ADDRESS`) as `0x${string}`
  let balance = "?"
  try {
    balance = formatEther(await client.getBalance({ address }))
  } catch {
    // offline: show the address anyway
  }
  const low = balance !== "?" && Number(balance) < 0.05 ? "  <- needs funds" : ""
  console.log(`${w.name.padEnd(8)} ${address}  ${balance} GLM  (${w.role})${low}`)
}
console.log("\nNext: docker compose up -d   (or: npm run dev:relayers for a local, non-Docker network)")
