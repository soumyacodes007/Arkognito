// Creates the Arkognito testnet wallets (relay-1, relay-2, issuer) and funds them
// from FUNDER_PRIVATE_KEY. Testnet only: refuses to run on any chain but Tiramisu.
// Private keys go to .env (git-ignored) and are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { tiramisu } from "@arkiv-network/sdk/chains"

const ENV_PATH = ".env"
const WALLETS = (process.env.WALLETS?.split(",") ?? ["RELAYER_1", "RELAYER_2", "ISSUER_WALLET"]) as string[]
const AMOUNT = parseEther(process.env.FUND_AMOUNT ?? "2")
const RPC_URL = process.env.ARKIV_RPC_URL ?? "https://rpc.tiramisu.db-chain.testnet.arkiv.network"

function readEnv(): Map<string, string> {
  const env = new Map<string, string>()
  if (!existsSync(ENV_PATH)) return env
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env.set(m[1], m[2])
  }
  return env
}

const env = readEnv()
let created = false
for (const name of WALLETS) {
  if (!env.get(`${name}_PRIVATE_KEY`)) {
    const key = generatePrivateKey()
    env.set(`${name}_PRIVATE_KEY`, key)
    env.set(`${name}_ADDRESS`, privateKeyToAccount(key).address)
    created = true
  }
}
if (created) {
  const lines = ["# Testnet-only wallets for Arkognito (Tiramisu). NEVER commit. NEVER put on Arkiv."]
  for (const [k, v] of env) lines.push(`${k}=${v}`)
  writeFileSync(ENV_PATH, lines.join("\n") + "\n")
}

const publicClient = createPublicClient({ chain: tiramisu, transport: http(RPC_URL) })
const chainId = await publicClient.getChainId()
if (chainId !== 7738577) throw new Error(`Refusing to fund: chain ${chainId} is not Tiramisu (7738577)`)

const funderKey = process.env.FUNDER_PRIVATE_KEY as `0x${string}` | undefined
if (!funderKey) throw new Error("FUNDER_PRIVATE_KEY is not set")
const funder = privateKeyToAccount(funderKey)
const wallet = createWalletClient({ account: funder, chain: tiramisu, transport: http(RPC_URL) })

console.log(`funder ${funder.address}: ${formatEther(await publicClient.getBalance({ address: funder.address }))}`)
for (const name of WALLETS) {
  const to = env.get(`${name}_ADDRESS`) as `0x${string}`
  const before = await publicClient.getBalance({ address: to })
  if (before >= AMOUNT) {
    console.log(`${name} ${to}: already has ${formatEther(before)}, skipped`)
    continue
  }
  const hash = await wallet.sendTransaction({ to, value: AMOUNT - before })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const after = await publicClient.getBalance({ address: to })
  console.log(`${name} ${to}: ${formatEther(after)} (tx ${hash}, ${receipt.status})`)
}
console.log(`funder after: ${formatEther(await publicClient.getBalance({ address: funder.address }))}`)
