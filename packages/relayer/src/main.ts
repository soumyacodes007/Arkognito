import { readFileSync } from "node:fs"
import { type Hex } from "viem"
import { WriteQueue, arkivClients } from "./arkiv"
import { loadConfig } from "./config"
import { Issuer, seedFromEnv } from "./issuer"
import { startRelayer } from "./server"
import { createTokenGate } from "./tokengate"

const cfg = loadConfig()
const arkiv = arkivClients(cfg.rpcUrl, cfg.accessKey, cfg.privateKey)
const log = (m: string) => console.log(`[${cfg.name}] ${m}`)

// This service can also run the issuer (ISSUER=on). The issuer uses its own wallet and write queue.
let issuer: Issuer | undefined
if (process.env.ISSUER === "on") {
  const issuerKey = process.env.ISSUER_WALLET_PRIVATE_KEY as Hex | undefined
  if (!issuerKey) throw new Error("ISSUER=on needs ISSUER_WALLET_PRIVATE_KEY")
  issuer = new Issuer(arkivClients(cfg.rpcUrl, cfg.accessKey, issuerKey), new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), {
    quotaPerDay: Number(process.env.TOKENS_PER_DAY ?? 5),
    quotaFile: process.env.ISSUER_QUOTA_FILE,
    attestationCodes: process.env.ISSUER_CODES_FILE
      ? new Set(readFileSync(process.env.ISSUER_CODES_FILE, "utf8").split(/\s+/).filter((l) => /^[0-9a-f]{64}$/.test(l)))
      : undefined,
    log,
  })
  cfg.issuerAddress = issuer.address
  cfg.issuerUrl ??= cfg.publicUrl
}

const routes = issuer ? issuer.routes.bind(issuer) : undefined
const gate = cfg.requireTokens
  ? (() => {
      if (!cfg.issuerAddress) throw new Error("REQUIRE_TOKENS=on needs ISSUER_WALLET_ADDRESS (or ISSUER=on)")
      return createTokenGate(arkiv, cfg.issuerAddress, log, routes)
    })()
  : routes
    ? { redeem: async () => ({}), hooks: {}, routes }
    : undefined

const relayer = startRelayer(cfg, arkiv, gate)
await relayer.listen()

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await relayer.close()
    process.exit(0)
  })
}
