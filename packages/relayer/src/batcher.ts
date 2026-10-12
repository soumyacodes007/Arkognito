// Batching (B1, B2, R5): wait for k requests or a max wait, never flush more often than every
// N blocks, shuffle, then one executeBatch that creates every record and hands each to its owner.
import { type AttributeInputs, type CreateEntityParameters, ExpirationTime } from "@arkiv-network/sdk"
import type { StatusResponse } from "arkognito"
import type { Address, Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { type ArkivClients, type WriteQueue, withRetry } from "./arkiv"
import type { EvilMode } from "./config"

export type BatchItem = {
  id: string
  owner: Address
  envelope: string
  attributes: AttributeInputs
  expSeconds: number
  receivedAt: number
  /** Spent-list id of the token that paid for this record (T4). */
  tokenId?: Hex
  /** Extra relayer-owned creates that must land in the same transaction (spent-token markers, T4). */
  sideCreates?: CreateEntityParameters[]
  /** Smallest batch this record may be written in (B2), and when to give up waiting for one. */
  minAnonymity?: number
  holdUntil?: number
}

export type BatchHooks = {
  /** Last check right before writing; returns the items still allowed (T4: spent list re-check). */
  beforeWrite?: (items: BatchItem[]) => Promise<{ keep: BatchItem[]; reject: { item: BatchItem; error: string }[] }>
}

export type BatcherOptions = {
  minBatch: number
  maxBatch: number
  maxWaitMs: number
  minIntervalBlocks: number
  evil: EvilMode
  log: (msg: string) => void
}

const enc = new TextEncoder()

/** Unbiased Fisher-Yates with crypto randomness. */
export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    let r: number
    const limit = Math.floor(0x1_0000_0000 / (i + 1)) * (i + 1)
    do {
      crypto.getRandomValues(buf)
      r = buf[0]
    } while (r >= limit)
    const j = r % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function isStalePrediction(e: unknown) {
  return /no entity|EntityNotFound|nonce too low|replacement transaction|already known/i.test(String((e as Error)?.message ?? e))
}

export class Batcher {
  readonly queue: BatchItem[] = []
  readonly status = new Map<string, StatusResponse & { at: number }>()
  lastFlushBlock = 0n
  flushing = false
  batches = 0
  #timer?: ReturnType<typeof setInterval>

  constructor(
    private arkiv: ArkivClients,
    private writer: WriteQueue,
    private opts: BatcherOptions,
    private hooks: BatchHooks = {},
  ) {}

  enqueue(item: BatchItem) {
    this.queue.push(item)
    this.status.set(item.id, { id: item.id, state: "queued", at: Date.now() })
  }

  start(everyMs = 1000) {
    this.#timer = setInterval(() => void this.tick(), everyMs)
  }

  stop() {
    clearInterval(this.#timer)
  }

  /** Decides whether to flush now. Exposed for tests. */
  async tick(): Promise<void> {
    this.#gc()
    if (this.flushing || this.queue.length === 0 || this.opts.evil === "drop") return
    const now = Date.now()
    // B2: a record that asked for a minimum anonymity set fails rather than land in a smaller batch.
    for (const it of [...this.queue]) {
      if (it.holdUntil !== undefined && now > it.holdUntil) {
        this.queue.splice(this.queue.indexOf(it), 1)
        this.#set(it.id, { state: "failed", error: `no batch of ${it.minAnonymity} formed in time; not written` })
      }
    }
    const take = this.#candidates()
    if (take.length === 0) return
    const oldest = Math.min(...take.map((q) => q.receivedAt))
    const full = take.length >= this.opts.minBatch
    const waited = now - oldest >= this.opts.maxWaitMs
    if (!full && !waited) return
    this.flushing = true
    try {
      const head = await withRetry(() => this.arkiv.publicClient.getBlockNumber())
      if (this.lastFlushBlock > 0n && head < this.lastFlushBlock + BigInt(this.opts.minIntervalBlocks)) return
      for (const it of take) this.queue.splice(this.queue.indexOf(it), 1)
      await this.#write(shuffle(take))
    } catch (e) {
      this.opts.log(`flush error: ${(e as Error).message}`)
    } finally {
      this.flushing = false
    }
  }

  /** The next batch: up to maxBatch records, minus any whose minimum anonymity this batch cannot meet. */
  #candidates(): BatchItem[] {
    let c = this.queue.slice(0, this.opts.maxBatch)
    for (;;) {
      const n = c.length
      const keep = c.filter((it) => (it.minAnonymity ?? 1) <= n)
      if (keep.length === c.length) return c
      c = keep
    }
  }

  async #write(items: BatchItem[]) {
    let batch = items
    if (this.hooks.beforeWrite) {
      const { keep, reject } = await this.hooks.beforeWrite(items)
      for (const r of reject) this.#set(r.item.id, { state: "failed", error: r.error })
      batch = keep
    }
    if (batch.length === 0) return

    const ownerFor = (it: BatchItem): Address =>
      this.opts.evil === "wrong-owner" ? privateKeyToAccount(generatePrivateKey()).address : it.owner
    const envelopeFor = (it: BatchItem) =>
      this.opts.evil === "tamper" ? it.envelope.replace(/"data":"(.)/, (_m, c) => `"data":"${c === "A" ? "B" : "A"}`) : it.envelope

    await this.writer.run(() => this.#send(batch, ownerFor, envelopeFor))
  }

  /** Sends one batch. On a failure that is not a stale prediction, splits it to isolate the bad record. */
  async #send(batch: BatchItem[], ownerFor: (it: BatchItem) => Address, envelopeFor: (it: BatchItem) => string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // Markers are shuffled on their own, so their order says nothing about which record they paid for.
      const side = shuffle(batch.flatMap((it) => it.sideCreates ?? []))
      const predicted = await this.arkiv.publicClient.predictEntityKeys({
        owner: this.arkiv.address,
        count: batch.length + side.length,
      })
      const creates: CreateEntityParameters[] = [
        ...batch.map((it, i) => ({
          payload: enc.encode(envelopeFor(it)),
          contentType: "application/json",
          attributes: it.attributes,
          expires: ExpirationTime.fromSeconds(it.expSeconds),
          salt: predicted[i].salt,
        })),
        ...side.map((c, j) => ({ ...c, salt: predicted[batch.length + j].salt })),
      ]
      try {
        const t0 = Date.now()
        const res = await this.arkiv.walletClient.executeBatch({
          creates,
          ownershipChanges: batch.map((it, i) => ({ entityKey: predicted[i].key, newOwner: ownerFor(it) })),
        })
        const receipt = await withRetry(() => this.arkiv.publicClient.getTransactionReceipt({ hash: res.txHash }))
        this.lastFlushBlock = receipt.blockNumber
        this.batches++
        if (this.opts.evil === "ghost") {
          this.opts.log(`ghost: wrote ${batch.length} record(s) but will never say so`)
          return
        }
        batch.forEach((it, i) =>
          this.#set(it.id, {
            state: "written",
            entityKey: res.createdEntities[i] as Hex,
            txHash: res.txHash,
            batchSize: batch.length,
            block: receipt.blockNumber.toString(),
          }),
        )
        this.opts.log(`batch ${this.batches}: ${batch.length} record(s) + ${side.length} marker(s) in ${Date.now() - t0} ms, tx ${res.txHash}`)
        return
      } catch (e) {
        if (attempt < 4 && isStalePrediction(e)) {
          this.opts.log(`stale key prediction, re-predicting (attempt ${attempt})`)
          continue
        }
        const msg = (e as Error).message.slice(0, 300)
        if (batch.length > 1) {
          // One bad record reverts the whole transaction; split so it cannot sink everyone else's.
          this.opts.log(`batch of ${batch.length} failed (${msg.slice(0, 120)}); splitting`)
          const mid = Math.ceil(batch.length / 2)
          await this.#send(batch.slice(0, mid), ownerFor, envelopeFor)
          await this.#send(batch.slice(mid), ownerFor, envelopeFor)
          return
        }
        this.#set(batch[0].id, { state: "failed", error: msg })
        this.opts.log(`record failed: ${msg}`)
        return
      }
    }
  }

  #set(id: string, s: Omit<StatusResponse, "id">) {
    this.status.set(id, { id, ...s, at: Date.now() })
  }

  #gc() {
    const cutoff = Date.now() - 60 * 60_000
    for (const [id, s] of this.status) if (s.at < cutoff && s.state !== "queued") this.status.delete(id)
  }
}
