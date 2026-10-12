import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Hex } from "viem"

// Load the repo-root .env when running locally; on a host the variables come from the environment.
for (const p of [".env", "../../.env"]) {
  const f = resolve(process.cwd(), p)
  if (existsSync(f)) {
    process.loadEnvFile(f)
    break
  }
}

/** Test-only misbehaviour. "ghost" writes the batch but never reports it, like a crash right after writing. */
export type EvilMode = "none" | "wrong-owner" | "tamper" | "drop" | "ghost"

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides }
  const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback)
  const keyVar = env.RELAYER_KEY_VAR ?? "RELAYER_PRIVATE_KEY"
  // A single self-hosted relayer can use the first key that `npm run setup` creates.
  const privateKey = (env[keyVar] || (env.RELAYER_KEY_VAR ? undefined : env.RELAYER_1_PRIVATE_KEY)) as Hex | undefined
  if (!privateKey) throw new Error(`${keyVar} is not set`)
  const port = num("PORT", 8787)
  return {
    name: env.RELAYER_NAME ?? "relay",
    privateKey,
    port,
    publicUrl: env.RELAYER_PUBLIC_URL ?? `http://localhost:${port}`,
    rpcUrl: env.ARKIV_RPC_URL ?? "https://rpc.tiramisu.db-chain.testnet.arkiv.network",
    accessKey: env.ARKIV_ACCESS_KEY,
    minBatch: num("MIN_BATCH", 5),
    maxBatch: num("MAX_BATCH", 40),
    maxWaitMs: num("MAX_WAIT_MS", 60_000),
    minIntervalBlocks: num("MIN_INTERVAL_BLOCKS", 5),
    heartbeat: (env.HEARTBEAT ?? "on") !== "off",
    heartbeatEveryMs: num("HEARTBEAT_EVERY_MS", 120_000),
    lowBalanceGlm: num("LOW_BALANCE_GLM", 0.2),
    maxQueue: num("MAX_QUEUE", 5000),
    ratePerMinute: num("RATE_LIMIT_PER_MIN", 30),
    maxMinAnonymity: num("MAX_MIN_ANONYMITY", 50),
    maxHoldMs: num("MAX_HOLD_MS", 30 * 60_000),
    ohttp: (env.OHTTP ?? "on") !== "off",
    evil: (env.ARKOGNITO_EVIL ?? "none") as EvilMode,
    // Phase 4: blind tokens.
    requireTokens: (env.REQUIRE_TOKENS ?? "off") === "on",
    issuerAddress: env.ISSUER_WALLET_ADDRESS as Hex | undefined,
    issuerUrl: env.ISSUER_URL,
  }
}

export type RelayerConfig = ReturnType<typeof loadConfig>
