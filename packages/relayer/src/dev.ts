// Local network for the demo: relay-1 (also the token issuer) on :8787 and relay-2 on :8788.
// Both require blind tokens. Reads keys from the repo-root .env.
import type { Hex } from "viem"
import { WriteQueue, arkivClients } from "./arkiv"
import { loadConfig } from "./config"
import { Issuer, seedFromEnv } from "./issuer"
import { startRelayer } from "./server"
import { createTokenGate } from "./tokengate"

const base = loadConfig({ RELAYER_KEY_VAR: "RELAYER_1_PRIVATE_KEY" })
const issuer = new Issuer(
  arkivClients(base.rpcUrl, base.accessKey, process.env.ISSUER_WALLET_PRIVATE_KEY as Hex),
  new WriteQueue(),
  seedFromEnv(process.env.ISSUER_RSA_SEED),
  { quotaPerDay: Number(process.env.TOKENS_PER_DAY ?? 20), log: (m) => console.log(`[issuer] ${m}`) },
)

const running: ReturnType<typeof startRelayer>[] = []
for (const [name, keyVar, port] of [
  ["relay-1", "RELAYER_1_PRIVATE_KEY", 8787],
  ["relay-2", "RELAYER_2_PRIVATE_KEY", 8788],
] as const) {
  const cfg = loadConfig({
    RELAYER_NAME: name,
    RELAYER_KEY_VAR: keyVar,
    PORT: String(port),
    RELAYER_PUBLIC_URL: `http://localhost:${port}`,
    REQUIRE_TOKENS: "on",
    ISSUER_WALLET_ADDRESS: issuer.address,
    ISSUER_URL: "http://localhost:8787",
    MAX_WAIT_MS: process.env.MAX_WAIT_MS ?? "20000",
  })
  const arkiv = arkivClients(cfg.rpcUrl, cfg.accessKey, cfg.privateKey)
  const log = (m: string) => console.log(`[${name}] ${m}`)
  const routes = name === "relay-1" ? issuer.routes.bind(issuer) : undefined
  const relayer = startRelayer(cfg, arkiv, createTokenGate(arkiv, issuer.address, log, routes))
  await relayer.listen()
  running.push(relayer)
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await Promise.all(running.map((r) => r.close()))
    process.exit(0)
  })
}
