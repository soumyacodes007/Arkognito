// Background traffic for a live demo: synthetic users saving synthetic sketches to the demo project
// through the live relayers, so a demo user's save lands in a full, shuffled batch instead of a
// batch of one. Throwaway keys, no funds, no real data. Stop with Ctrl+C.
//
//   npx tsx --conditions=arkognito-source scripts/demo-crowd.ts
//   USERS=8 EVERY_S=20 MINUTES=15 npx tsx --conditions=arkognito-source scripts/demo-crowd.ts
//
// Users are split across the live relayers, and each is replaced after WRITES_PER_USER saves so no
// identity runs into the issuer's daily quota.
import { createPublicClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { type ArkivReader, createPrivateClient, heartbeatRelayers, memoryStore } from "../packages/sdk/src/index.ts"

const PROJECT = process.env.PROJECT ?? "arkognito-demo-sketch"
const USERS = Number(process.env.USERS ?? 8)
const EVERY_S = Number(process.env.EVERY_S ?? 20)
const MINUTES = Number(process.env.MINUTES ?? 20)
const WRITES_PER_USER = Number(process.env.WRITES_PER_USER ?? 4)

const reader = createPublicClient({ chain: tiramisu, transport: http(process.env.ARKIV_RPC_URL) }) as unknown as ArkivReader
const t0 = Date.now()
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)

/** A random scribble on the 256 grid: a few smooth strokes. */
function scribble() {
  const strokes: number[][] = []
  for (let s = 0; s < 1 + Math.floor(Math.random() * 3); s++) {
    let [x, y] = [40 + Math.random() * 176, 40 + Math.random() * 176]
    let a = Math.random() * Math.PI * 2
    const pts: number[] = []
    for (let i = 0; i < 20 + Math.floor(Math.random() * 40); i++) {
      a += (Math.random() - 0.5) * 0.8
      x = Math.max(8, Math.min(248, x + Math.cos(a) * 5))
      y = Math.max(8, Math.min(248, y + Math.sin(a) * 5))
      pts.push(Math.round(x), Math.round(y))
    }
    strokes.push(pts)
  }
  return { strokes }
}

type Slot = { n: number; relayer: string; client?: Awaited<ReturnType<typeof createPrivateClient>>; writes: number; busy: boolean }

async function freshClient(relayer: string) {
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
  return createPrivateClient({
    app: PROJECT,
    relayers: [relayer],
    wallet,
    publicClient: reader,
    isolateKeys: false,
    verifyDeterminism: "never",
    tokenStore: memoryStore(),
    delayMs: [0, 6000],
    rarityK: 0,
  })
}

const live = (await heartbeatRelayers(reader)).map((r) => r.url)
const relayers = (process.env.RELAYERS?.split(",") ?? live).filter(Boolean)
if (relayers.length === 0) throw new Error("no live relayer found on Arkiv; pass RELAYERS=https://…")
log(`crowd: ${USERS} synthetic users, one save each every ~${EVERY_S}s, for ${MINUTES} min, project ${PROJECT}`)
for (const r of relayers) log(`  relayer ${r}`)

const slots: Slot[] = Array.from({ length: USERS }, (_, n) => ({ n, relayer: relayers[n % relayers.length], writes: 0, busy: false }))
let saved = 0
let failed = 0

async function turn(slot: Slot) {
  if (slot.busy) return
  slot.busy = true
  try {
    if (!slot.client || slot.writes >= WRITES_PER_USER) {
      slot.client = await freshClient(slot.relayer)
      slot.writes = 0
    }
    slot.writes++
    const res = await slot.client.createEntity({
      payload: jsonToPayload(scribble()),
      contentType: "application/json",
      attributes: { project: PROJECT, type: "sketch" },
      expires: ExpirationTime.fromDays(1),
    })
    saved++
    log(`user ${slot.n} saved ${res.entityKey.slice(0, 10)}… via ${new URL(res.relayer || slot.relayer).host} in a batch of ${res.batchSize ?? "?"}`)
  } catch (e) {
    failed++
    log(`user ${slot.n}: ${(e as Error).message.slice(0, 160)}`)
    slot.client = undefined
  } finally {
    slot.busy = false
  }
}

// Stagger the users across the interval so batches keep filling instead of arriving in one burst.
const timers = slots.map((slot, i) =>
  setTimeout(() => {
    void turn(slot)
    timers.push(setInterval(() => void turn(slot), EVERY_S * 1000 * (0.8 + Math.random() * 0.4)) as unknown as ReturnType<typeof setTimeout>)
  }, (i / slots.length) * EVERY_S * 1000),
)

const stop = () => {
  for (const t of timers) clearTimeout(t), clearInterval(t)
  log(`stopping: ${saved} saved, ${failed} failed in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  process.exit(0)
}
process.on("SIGINT", stop)
setTimeout(stop, MINUTES * 60_000)
