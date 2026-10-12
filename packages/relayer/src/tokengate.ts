// Token redemption at the relayer (T1, T4, T8, T9). Sees tokens, never wallets.
import { ExpirationTime } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import {
  BLOCK_TIME_SECONDS,
  ARKOGNITO_PROJECT,
  acceptableEpochs,
  fetchIssuerKey,
  verifyToken,
  type SubmitRequest,
} from "arkognito"
import type { Address, Hex } from "viem"
import type { ArkivClients } from "./arkiv"
import type { BatchItem } from "./batcher"
import type { TokenGate } from "./server"

const DAY_MS = 86_400_000

export function createTokenGate(
  arkiv: ArkivClients,
  issuer: Address,
  log: (m: string) => void,
  routes?: TokenGate["routes"],
): TokenGate & { spentOnArkiv(id: Hex): Promise<boolean> } {
  const keys = new Map<string, { at: number; key: Promise<CryptoKey | undefined> }>()
  const inFlight = new Set<string>()

  function keyFor(app: string, epoch: number) {
    const id = `${app}|${epoch}`
    const cached = keys.get(id)
    if (cached && Date.now() - cached.at < 60_000) return cached.key
    const key = fetchIssuerKey(arkiv.publicClient, issuer, app, epoch).then((k) => k?.key)
    keys.set(id, { at: Date.now(), key })
    key.catch(() => keys.delete(id))
    return key
  }

  async function spentOnArkiv(id: Hex): Promise<boolean> {
    const { entities } = await arkiv.publicClient
      .select({ key: true })
      .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.spent"), eq("tokenid", bytes32(id)))
      .limit(1)
      .fetch()
    return entities.length > 0
  }

  // T4, after the fact: two relayers can each pass the pre-write check in the same block. Scan the
  // shared spent list for any token id recorded twice and report it.
  const doubleSpends = new Set<string>()
  async function scanDoubleSpends(): Promise<string[]> {
    const counts = new Map<string, number>()
    for (const epoch of acceptableEpochs()) {
      const q = arkiv.publicClient
        .select({ attributes: true })
        .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.spent"), eq("epoch", i32(epoch)))
        .limit(200)
      for await (const e of q) {
        const id = String(e.attributes.tokenid?.value ?? "")
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    for (const [id, n] of counts) {
      if (n > 1 && !doubleSpends.has(id)) {
        doubleSpends.add(id)
        log(`DOUBLE SPEND: token ${id.slice(0, 14)}… was redeemed ${n} times across relayers (T4 race)`)
      }
    }
    return [...doubleSpends]
  }
  let monitorTimer: ReturnType<typeof setInterval> | undefined

  async function redeem(req: SubmitRequest): Promise<Partial<BatchItem>> {
    const t = req.token
    if (!t) throw new Error("a rate-limit token is required")
    if (!acceptableEpochs().includes(t.epoch)) throw new Error(`token is from day ${t.epoch}, which is no longer accepted`)
    const key = await keyFor(req.app, t.epoch)
    if (!key) throw new Error(`no issuer key on Arkiv for ${req.app} day ${t.epoch}`)
    const id = await verifyToken(key, t)
    if (inFlight.has(id) || (await spentOnArkiv(id))) throw new Error("token already spent")
    inFlight.add(id)
    const seconds = ((t.epoch + 2) * DAY_MS - Date.now()) / 1000
    return {
      tokenId: id,
      sideCreates: [
        {
          payload: new Uint8Array(),
          contentType: "application/octet-stream",
          attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.spent", app: req.app, epoch: i32(t.epoch), tokenid: bytes32(id) },
          expires: ExpirationTime.fromBlocks(Math.ceil(seconds / BLOCK_TIME_SECONDS)),
        },
      ],
    }
  }

  return {
    redeem,
    routes,
    spentOnArkiv,
    monitor: {
      scan: scanDoubleSpends,
      found: () => [...doubleSpends],
      start(everyMs = 5 * 60_000) {
        monitorTimer = setInterval(() => void scanDoubleSpends().catch(() => undefined), everyMs)
      },
      stop: () => clearInterval(monitorTimer),
    },
    hooks: {
      // T4: last check right before writing, in case another relayer spent the same token meanwhile.
      async beforeWrite(items) {
        const keep: BatchItem[] = []
        const reject: { item: BatchItem; error: string }[] = []
        const seen = new Set<string>()
        for (const it of items) {
          if (!it.tokenId) {
            keep.push(it)
            continue
          }
          if (seen.has(it.tokenId) || (await spentOnArkiv(it.tokenId))) {
            reject.push({ item: it, error: "token already spent" })
            log("refused a token spent elsewhere just before writing (T4)")
          } else {
            seen.add(it.tokenId)
            keep.push(it)
          }
        }
        return { keep, reject }
      },
    },
  }
}
