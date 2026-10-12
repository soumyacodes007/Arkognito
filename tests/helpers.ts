import { existsSync } from "node:fs"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { KeyVault, sealEnvelope, toWire, type SubmitRequest } from "arkognito"
import { type AttributeInputs } from "@arkiv-network/sdk"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { arkivClients } from "../packages/relayer/src/arkiv"
import { loadConfig } from "../packages/relayer/src/config"
import { startRelayer, type TokenGate } from "../packages/relayer/src/server"

if (existsSync(".env")) process.loadEnvFile(".env")

export const runId = crypto.randomUUID().slice(0, 8)
const accessKey = process.env.ARKIV_ACCESS_KEY

export const publicClient = createPublicClient({
  chain: tiramisu,
  transport: http(process.env.ARKIV_RPC_URL, accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {}),
})

let failures = 0
export function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
export function done() {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A synthetic user with a throwaway EOA (synthetic data only). */
export async function makeUser(app: string) {
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
  return { wallet, vault: await KeyVault.fromWallet(wallet, app) }
}

export async function localRelayer(name: string, keyVar: string, port: number, env: Record<string, string> = {}, gate?: TokenGate) {
  const cfg = loadConfig({
    RELAYER_NAME: name,
    RELAYER_KEY_VAR: keyVar,
    PORT: String(port),
    RELAYER_PUBLIC_URL: `http://localhost:${port}`,
    HEARTBEAT: "off",
    MIN_BATCH: "1",
    MAX_WAIT_MS: "0",
    MIN_INTERVAL_BLOCKS: "1",
    // Test traffic comes from one address; tests that check the limit set their own.
    RATE_LIMIT_PER_MIN: "1000000",
    ...env,
  })
  const r = startRelayer(cfg, arkivClients(cfg.rpcUrl, cfg.accessKey, cfg.privateKey), gate)
  await r.listen()
  return { ...r, url: cfg.publicUrl, cfg }
}

/** Raw submission without waiting: used to generate background traffic from many users at once. */
export async function rawSubmit(url: string, vault: KeyVault, i: number, app: string, attributes: AttributeInputs, data = `noise ${i}`, extra: Partial<SubmitRequest> = {}) {
  const key = await vault.newRecord()
  const signer = await vault.signer(key.ref)
  const attrs = { ...attributes, vtag: key.tag }
  const sealed = await sealEnvelope({
    signer, app, payload: new TextEncoder().encode(data), contentType: "text/plain", attributes: attrs, expSeconds: 3600,
  })
  const body: SubmitRequest = { app, owner: signer.address, envelope: sealed.text, attributes: toWire(attrs), expSeconds: 3600, ...extra }
  const res = await fetch(`${url}/v1/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`submit ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

export async function waitAll(url: string, ids: string[], timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  const out = new Map<string, { state: string; entityKey?: string; batchSize?: number; txHash?: string }>()
  while (Date.now() < deadline && out.size < ids.length) {
    for (const id of ids) {
      if (out.has(id)) continue
      const s = (await (await fetch(`${url}/v1/records/${id}`)).json()) as { state: string }
      if (s.state !== "queued") out.set(id, s)
    }
    if (out.size < ids.length) await sleep(2000)
  }
  return out
}
