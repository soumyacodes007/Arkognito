// Shared setup for the Phase 1 spike scripts: env, clients with the access key header, helpers.
import { existsSync } from "node:fs"
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

if (existsSync(".env")) process.loadEnvFile(".env")

export const PROJECT = "arkognito-7f3k"
const RPC_URL = process.env.ARKIV_RPC_URL ?? tiramisu.rpcUrls.default.http[0]
const ACCESS_KEY = process.env.ARKIV_ACCESS_KEY

export const transport = () =>
  http(RPC_URL, ACCESS_KEY ? { fetchOptions: { headers: { "X-API-KEY": ACCESS_KEY } } } : {})

export const publicClient = createPublicClient({ chain: tiramisu, transport: transport() })

export function walletFor(envName: string) {
  const key = process.env[envName] as Hex | undefined
  if (!key) throw new Error(`${envName} is not set in .env`)
  return createWalletClient({ chain: tiramisu, transport: transport(), account: privateKeyToAccount(key) })
}

export function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) process.exitCode = 1
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
