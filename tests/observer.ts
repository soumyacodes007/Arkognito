// The outside observer (PRD §6): reads only public chain data and tries to group records by person.
// Used by the Phase 3 linkage experiment; the same attack runs in the demo's observer view.
import { eq } from "@arkiv-network/sdk/query"
import type { Address, Hex } from "viem"
import type { publicClient as PC } from "./helpers"

export type ObservedRecord = {
  key: Hex
  owner: Address
  creator: Address
  createdAt: bigint
  expiresAt: bigint
  size: number
  tx?: Hex
  /** Position of the record inside its transaction (log order). */
  position?: number
}

/** Everything an observer can read about one app's records. */
export async function observe(client: typeof PC, project: string): Promise<ObservedRecord[]> {
  const out: ObservedRecord[] = []
  const q = client
    .select({ key: true, owner: true, creator: true, createdAt: true, expiresAt: true, payload: true })
    .where(eq("project", project))
    .limit(200)
  for await (const e of q) {
    out.push({ key: e.key, owner: e.owner, creator: e.creator, createdAt: e.createdAt, expiresAt: e.expiresAt, size: e.payload.length })
  }
  // Recover each record's transaction and its position in it from the EntityCreated logs.
  const blocks = [...new Set(out.map((r) => r.createdAt))]
  for (const b of blocks) {
    const logs = await client.getLogs({ fromBlock: b, toBlock: b, address: "0x4400000000000000000000000000000000000044" })
    let pos = 0
    for (const log of logs) {
      const key = log.topics[1]?.toLowerCase()
      const rec = out.find((r) => r.key.toLowerCase() === key)
      if (rec) {
        rec.tx = log.transactionHash ?? undefined
        rec.position = pos++
      }
    }
  }
  return out
}

/**
 * The attack: link records in consecutive batches that share any observable feature (owner,
 * position in batch, size, expiry lifetime). Returns the predicted same-person pairs.
 */
export function attack(records: ObservedRecord[]): [Hex, Hex][] {
  const byTx = new Map<string, ObservedRecord[]>()
  for (const r of records) {
    const k = r.tx ?? `block-${r.createdAt}`
    byTx.set(k, [...(byTx.get(k) ?? []), r])
  }
  const batches = [...byTx.values()].sort((a, b) => Number(a[0].createdAt - b[0].createdAt))
  const pairs: [Hex, Hex][] = []
  for (let i = 1; i < batches.length; i++) {
    for (const a of batches[i - 1]) {
      // Best observable match in the next batch: same owner, else same position, else same size and lifetime.
      const next = batches[i]
      const life = (r: ObservedRecord) => r.expiresAt - r.createdAt
      const m =
        next.find((b) => b.owner.toLowerCase() === a.owner.toLowerCase()) ??
        next.find((b) => b.position === a.position) ??
        next.find((b) => b.size === a.size && life(b) === life(a))
      if (m) pairs.push([a.key, m.key])
    }
  }
  return pairs
}

/** Precision of predicted pairs against ground truth (key -> person). */
export function precision(pairs: [Hex, Hex][], truth: Map<string, string>) {
  if (pairs.length === 0) return 0
  const right = pairs.filter(([a, b]) => truth.get(a.toLowerCase()) === truth.get(b.toLowerCase())).length
  return right / pairs.length
}
