import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { fromWire, parseEnvelope, type StatusResponse, type SubmitRequest } from "arkognito"
import { assertGroup, assertMembership, createSemaphoreReader, MembershipInvalid, VerificationUnavailable, verifyMembership, type SemaphoreGroup } from "arkognito/semaphore"
import type { ArkivClients } from "./arkiv"
import type { BatchHooks, BatchItem } from "./batcher"
import { isAddress, type Address } from "viem"

type Entry = { id: string; state: "pending" | "confirmed"; requestId: string; receipt?: StatusResponse }
export class AdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
/** Shared single-host journal. Never automatically steals a stale lock or retries an uncertain send. */
export class FileAdmissionJournal {
  constructor(readonly file: string) { mkdirSync(dirname(file), { recursive: true }) }
  private locked<T>(fn: () => T): T {
    let fd: number
    try { fd = openSync(`${this.file}.lock`, "wx", 0o600) } catch { throw new VerificationUnavailable("Admission coordinator locked; reconcile before resuming") }
    try { return fn() } catch (e) {
      if (e instanceof AdmissionError || e instanceof VerificationUnavailable) throw e
      throw new VerificationUnavailable("Admission journal unavailable; reconcile before resuming", { cause: e })
    } finally { closeSync(fd); unlinkSync(`${this.file}.lock`) }
  }
  private rows(): Entry[] {
    if (!existsSync(this.file)) return []
    try {
      const rows = readFileSync(this.file, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s) as Entry)
      if (rows.some(r => typeof r.id !== "string" || typeof r.requestId !== "string" || !["pending", "confirmed"].includes(r.state))) throw Error("Invalid row")
      return rows
    } catch { throw new VerificationUnavailable("Admission journal corrupt; reconciliation required") }
  }
  claim(id: string, requestId: string): void {
    this.locked(() => {
      const prior = this.rows().reverse().find(r => r.id === id)
      if (prior) throw new AdmissionError(prior.state === "confirmed" ? 409 : 503, prior.state === "confirmed" ? "Nullifier already confirmed" : "Pending admission requires reconciliation")
      appendFileSync(this.file, `${JSON.stringify({ id, state: "pending", requestId })}\n`, { mode: 0o600, flush: true })
    })
  }
  confirm(id: string, requestId: string, receipt: StatusResponse): void {
    this.locked(() => {
      const prior = this.rows().reverse().find(r => r.id === id)
      if (prior?.requestId !== requestId) throw new VerificationUnavailable("Admission reservation mismatch")
      appendFileSync(this.file, `${JSON.stringify({ id, state: "confirmed", requestId, receipt })}\n`, { mode: 0o600, flush: true })
    })
  }
}

export class SemaphoreGate {
  private groups: SemaphoreGroup[]
  private journal: FileAdmissionJournal
  constructor(private arkiv: ArkivClients, groups: SemaphoreGroup[], journal: string, private historyBlocks = 10000, private trustedRelayers: Address[] = []) {
    if (!Array.isArray(groups)) throw Error("Semaphore groups configuration must be an array")
    groups.forEach(assertGroup)
    if (trustedRelayers.some(a => !isAddress(a))) throw Error("Invalid trusted relayer address")
    if (new Set(groups.map(g => g.project)).size !== groups.length) throw Error("One configured Semaphore group per project required")
    if (!journal) throw Error("Semaphore requires a durable journal path")
    this.groups = groups; this.journal = new FileAdmissionJournal(journal)
  }
  get keys() { return this.groups.map(g => g.key) }
  async authorize(req: SubmitRequest, item: BatchItem): Promise<boolean> {
    const envelope = parseEnvelope(req.envelope)
    const project = String(item.attributes.project && typeof item.attributes.project === "object" ? (item.attributes.project as { value: unknown }).value : item.attributes.project)
    const group = this.groups.find(g => g.project === project)
    if (!group) {
      if (envelope.membership || Object.keys(item.attributes).some(k => k.startsWith("zk"))) throw new AdmissionError(403, "Semaphore group not configured")
      return false
    }
    if (!envelope.membership) throw new AdmissionError(403, "This project requires a Semaphore membership proof")
    assertMembership(envelope.membership)
    const trustedRelayers = [...new Set([this.arkiv.address, ...this.trustedRelayers])]
    const reader = createSemaphoreReader(this.arkiv.publicClient, group, { trustedRelayers, maxHistoryBlocks: this.historyBlocks })
    const at = await this.arkiv.publicClient.getBlockNumber({ cacheTime: 0 })
    const snapshot = await reader.getSnapshot(BigInt(envelope.membership.rootBlock))
    await verifyMembership({ group, snapshot, membership: envelope.membership, owner: req.owner, envelope, attributes: fromWire(req.attributes), atBlock: at })
    const previous = await reader.readPosts(envelope.membership.proof.scope)
    if (previous.spent.some(p => p.nullifier === envelope.membership!.proof.nullifier)) throw new AdmissionError(409, "Valid nullifier already published")
    const id = `${group.key.toLowerCase()}:${envelope.membership.proof.scope}:${envelope.membership.proof.nullifier}`
    this.journal.claim(id, item.id)
    item.membership = { id, group }
    item.flags = { readonly: true }
    return true
  }
  hooks: BatchHooks = {
    beforeWrite: async items => {
      const keep: BatchItem[] = [], reject: { item: BatchItem; error: string }[] = []
      for (const item of items) {
        if (!item.membership) { keep.push(item); continue }
        try {
          const envelope = parseEnvelope(item.envelope), m = envelope.membership!
          const reader = createSemaphoreReader(this.arkiv.publicClient, item.membership.group, { trustedRelayers: [this.arkiv.address], maxHistoryBlocks: this.historyBlocks })
          await verifyMembership({ group: item.membership.group, snapshot: await reader.getSnapshot(BigInt(m.rootBlock)), membership: m, owner: item.owner, envelope, attributes: item.attributes, atBlock: await this.arkiv.publicClient.getBlockNumber({ cacheTime: 0 }) })
          keep.push(item)
        } catch (e) { reject.push({ item, error: `Membership write stopped; reservation retained: ${(e as Error).message}` }) }
      }
      return { keep, reject }
    },
    afterWrite: async (items, statuses) => {
      for (const item of items) if (item.membership) this.journal.confirm(item.membership.id, item.id, statuses.get(item.id)!)
    },
  }
}

export const membershipHttpStatus = (e: unknown) => e instanceof AdmissionError ? e.status : e instanceof VerificationUnavailable ? 503 : e instanceof MembershipInvalid ? 400 : undefined
