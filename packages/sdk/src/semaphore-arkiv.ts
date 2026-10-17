import { ExpirationTime, type Entity, type PublicArkivClient, type WalletArkivClient } from "@arkiv-network/sdk"
import { u256, key as entityKey } from "@arkiv-network/sdk/attr"
import { ENTITY_EVENTS_ABI, decodeCreationFlags } from "@arkiv-network/sdk/entity"
import { eq } from "@arkiv-network/sdk/query"
import { Group } from "@semaphore-protocol/group"
import { decodeEventLog, type Address, type Hex } from "viem"
import { parseEnvelope, type Envelope } from "./envelope.ts"
import { verifyRecord } from "./reader.ts"
import { assertGroup, assertMembers, assertRules, assertMembership, MembershipInvalid, VerificationUnavailable, verifyMembership, type GroupSnapshot, type Membership, type SemaphoreGroup, type SemaphoreRules } from "./semaphore.ts"

export type SemaphoreReader = Pick<PublicArkivClient, "select" | "getBlockNumber" | "getChainId" | "getLogs" | "getTransactionReceipt" | "predictEntityKeys">
export type SemaphoreWriter = Pick<WalletArkivClient, "executeBatch"> & { account: { address: Address } }
export type WriteCoordinator = { run<T>(fn: () => Promise<T>): Promise<T> }
/** Reuse exactly one instance for all writes from a wallet in one process. */
export class SemaphoreWriteQueue implements WriteCoordinator {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}
type Row = { [K in "key" | "owner" | "creator" | "payload" | "attributes" | "createdAt" | "expiresAt" | "creationFlags"]: NonNullable<Entity[K]> }
export type Publication = { key: Hex; owner: Address; creator: Address; envelope: Envelope; attributes: NonNullable<Entity["attributes"]>; membership: Membership; block: bigint; expiresAt: bigint; transactionIndex: number; logIndex: number; txHash: Hex }
export type MembershipReadResult = { snapshot: string; accepted: Publication[]; rejected: { key: Hex; reason: string }[]; spent: { key: Hex; nullifier: string; live: boolean }[] }
const SYSTEM = "0x4400000000000000000000000000000000000044"
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const text = new TextDecoder()
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

/** Complete pinned walks; unavailable history never becomes an empty successful result. */
export function createSemaphoreReader(reader: SemaphoreReader, group: SemaphoreGroup, options: { trustedRelayers: readonly Address[]; maxHistoryBlocks?: number; maxPages?: number; maxPublications?: number } ) {
  assertGroup(group)
  if (!options.trustedRelayers.length) throw new MembershipInvalid("Explicit trusted relayers required")
  const maxPages = options.maxPages ?? 100
  const maxBlocks = options.maxHistoryBlocks ?? 10000
  const maxPublications = options.maxPublications ?? 10000
  if (![maxPages, maxBlocks, maxPublications].every(n => Number.isSafeInteger(n) && n > 0)) throw new MembershipInvalid("Positive verification budgets required")
  const snapshots = new Map<string, Promise<GroupSnapshot>>()
  async function available<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn() } catch (e) {
      if (e instanceof MembershipInvalid || e instanceof VerificationUnavailable) throw e
      throw new VerificationUnavailable("Arkiv verification data unavailable", { cause: e })
    }
  }
  async function all(block: bigint, creator: Address, filters: ReturnType<typeof eq>[]): Promise<Row[]> {
    let page = await reader.select({ key: true, owner: true, creator: true, payload: true, attributes: true, createdAt: true, expiresAt: true, creationFlags: true }).where(eq("project", group.project), ...filters).createdBy(creator).atBlock(block).limit(200).fetch()
    const out: Row[] = []
    for (let n = 1; ; n++) {
      if (page.blockNumber !== block) throw new VerificationUnavailable("Query snapshot mismatch")
      for (const row of page.entities) {
        if (!row.key || !row.owner || !row.creator || !row.payload || !row.attributes || row.createdAt === undefined || row.expiresAt === undefined || !row.creationFlags) throw new VerificationUnavailable("Incomplete selected entity")
        out.push(row as Row)
      }
      if (!page.hasNextPage()) return out
      if (n >= maxPages) throw new VerificationUnavailable("Membership query page budget exhausted")
      page = await page.next()
    }
  }
  async function getSnapshot(block?: bigint, allowUnready = false): Promise<GroupSnapshot> {
    return available(async () => {
      if (await reader.getChainId() !== 7738577) throw new MembershipInvalid("Semaphore supports Tiramisu only")
      const at = block ?? await reader.getBlockNumber({ cacheTime: 0 })
      if (at < BigInt(group.fromBlock)) throw new MembershipInvalid("Snapshot predates group")
      const load = async (): Promise<GroupSnapshot> => {
        const rulesRow = (await all(at, group.admin, [eq("$key", entityKey(group.key))])).find(e => same(e.key, group.key))
        if (!rulesRow || !rulesRow.creationFlags?.readonly || rulesRow.createdAt !== BigInt(group.fromBlock)) throw new MembershipInvalid("Trusted readonly group not found")
        let rules: SemaphoreRules
        try { rules = JSON.parse(text.decode(rulesRow.payload)); assertRules(rules) } catch { throw new MembershipInvalid("Invalid group rules payload") }
        const rows = await all(at, group.admin, [eq("type", "veil.member"), eq("group", group.key)])
        rows.sort((a, b) => Number(a.attributes.memberindex?.value) - Number(b.attributes.memberindex?.value))
        if (rows.some((e, i) => !e.creationFlags?.readonly || e.attributes.memberindex?.type !== "i32" || e.attributes.memberindex.value !== i || e.attributes.commitment?.type !== "u256")) throw new MembershipInvalid("Invalid ordered readonly membership")
        const members = rows.map(e => String(e.attributes.commitment.value))
        assertMembers(members, rules, allowUnready)
        return { group, rules, block: at.toString(), members, root: new Group(members.map(BigInt)).root.toString() }
      }
      const cacheKey = `${at}:${allowUnready}`
      if (!snapshots.has(cacheKey)) {
        if (snapshots.size >= 64) snapshots.delete(snapshots.keys().next().value!)
        snapshots.set(cacheKey, load())
      }
      try { return await snapshots.get(cacheKey)! } catch (e) { snapshots.delete(cacheKey); throw e }
    })
  }
  async function check(row: Row, atBlock: bigint): Promise<Membership> {
    let envelope: Envelope
    try { envelope = parseEnvelope(row.payload!) } catch { throw new MembershipInvalid("Invalid record envelope") }
    const membership = envelope.membership
    if (!membership) throw new MembershipInvalid("Membership proof missing")
    assertMembership(membership)
    if (typeof membership.rootBlock !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(membership.rootBlock) || typeof membership.group !== "string" || !same(membership.group, group.key)) throw new MembershipInvalid("Invalid membership snapshot identifiers")
    const record = await verifyRecord(row, { owner: row.owner, relayers: options.trustedRelayers })
    if (!record.ok) throw new MembershipInvalid(record.reason)
    const snapshot = await getSnapshot(BigInt(membership.rootBlock))
    await verifyMembership({ group, snapshot, membership, owner: row.owner, envelope, attributes: row.attributes, atBlock })
    return membership
  }
  async function readPosts(scope?: string): Promise<MembershipReadResult> {
    return available(async () => {
      const head = await reader.getBlockNumber({ cacheTime: 0 })
      const from = BigInt(group.fromBlock)
      if (head < from || head - from > BigInt(maxBlocks)) throw new VerificationUnavailable("Complete membership history exceeds configured block budget")
      // Also assert that the oldest required state is still available.
      await getSnapshot(from, true)
      const history: Publication[] = []
      const receipts = new Map<Hex, Awaited<ReturnType<SemaphoreReader["getTransactionReceipt"]>>>()
      const blocks = new Map<string, Row[]>()
      const event = ENTITY_EVENTS_ABI.find(e => e.name === "EntityCreated")!
      for (let start = from; start <= head; start += 1000n) {
        const end = start + 999n < head ? start + 999n : head
        const logs = await reader.getLogs({ address: SYSTEM, event, args: { owner: [...options.trustedRelayers] }, fromBlock: start, toBlock: end })
        for (const log of logs) {
          const decoded = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics })
          if (decoded.eventName !== "EntityCreated" || !options.trustedRelayers.some(a => same(a, decoded.args.owner))) continue
          if (log.blockNumber === null || log.transactionIndex === null || log.logIndex === null || !log.transactionHash || !log.blockHash) throw new VerificationUnavailable("Unconfirmed publication log")
          const block = log.blockNumber
          const cacheKey = `${block}:${decoded.args.owner.toLowerCase()}`
          if (!blocks.has(cacheKey)) blocks.set(cacheKey, await all(block, decoded.args.owner, [eq("zkgroup", group.key), ...(scope ? [eq("zkscope", scope)] : [])]))
          const row = blocks.get(cacheKey)!.find(e => same(e.key, decoded.args.entityKey))
          if (!row) continue
          if (!receipts.has(log.transactionHash)) receipts.set(log.transactionHash, await reader.getTransactionReceipt({ hash: log.transactionHash }))
          const r = receipts.get(log.transactionHash)!
          const actual = r.logs.find(l => l.logIndex === log.logIndex && l.blockHash === log.blockHash && same(l.address, SYSTEM) && l.data === log.data && l.topics.join() === log.topics.join())
          if (!actual || r.status !== "success" || !r.to || !same(r.to, SYSTEM) || !same(r.from, decoded.args.owner) || r.blockHash !== log.blockHash || r.blockNumber !== block || r.transactionIndex !== log.transactionIndex) throw new VerificationUnavailable("Publication receipt authentication failed")
          // Even malformed proofs are retained as rejected evidence, without consuming nullifiers.
          let envelope: Envelope
          try { envelope = parseEnvelope(row.payload!) } catch { continue }
          if (!envelope.membership) continue
          const p: Publication = { key: row.key, owner: row.owner, creator: row.creator, envelope, attributes: row.attributes, membership: envelope.membership, block, expiresAt: row.expiresAt, transactionIndex: log.transactionIndex, logIndex: log.logIndex, txHash: log.transactionHash }
          if (!decodeCreationFlags(Number(decoded.args.creationFlags)).readonly || !row.creationFlags?.readonly) {
            // Mark invalid without trusting later mutable contents.
            p.envelope = { ...envelope, membership: undefined }
          }
          if (history.length >= maxPublications) throw new VerificationUnavailable("Publication history budget exhausted")
          history.push(p)
        }
      }
      history.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex)
      const live = new Set<string>()
      for (const creator of options.trustedRelayers) for (const row of await all(head, creator, [eq("zkgroup", group.key)])) live.add(row.key.toLowerCase())
      const result: MembershipReadResult = { snapshot: head.toString(), accepted: [], rejected: [], spent: [] }
      const seen = new Set<string>()
      for (const post of history) {
        try {
          await check({ key: post.key, owner: post.owner, creator: post.creator, payload: bytes(post.envelope), attributes: post.attributes, createdAt: post.block, expiresAt: post.expiresAt, creationFlags: { readonly: true, permissionlessExtension: false, raw: 1 } }, post.block)
          const id = `${post.membership.proof.scope}:${post.membership.proof.nullifier}`
          if (seen.has(id)) throw new MembershipInvalid("Duplicate nullifier")
          seen.add(id)
          const present = live.has(post.key.toLowerCase())
          result.spent.push({ key: post.key, nullifier: post.membership.proof.nullifier, live: present })
          if (present) result.accepted.push(post)
        } catch (e) {
          if (!(e instanceof MembershipInvalid)) throw e
          result.rejected.push({ key: post.key, reason: e.message })
        }
      }
      return result
    })
  }
  return { getSnapshot, readPosts, check }
}

/** Caller must exclusively control this signer and share its coordinator with every other writer. */
export async function createSemaphoreGroup(args: { reader: SemaphoreReader; wallet: SemaphoreWriter; coordinator: WriteCoordinator; project: string; members?: string[] | ((group: SemaphoreGroup) => Promise<string[]>); memberCount?: number; rules: SemaphoreRules; expires: number }) {
  assertRules(args.rules)
  const count = !args.members ? 0 : Array.isArray(args.members) ? args.members.length : args.memberCount
  if (!Number.isInteger(count) || count! < 0 || count! > 2 ** args.rules.depth) throw new MembershipInvalid("Initial member count required")
  if (await args.reader.getChainId() !== 7738577) throw new MembershipInvalid("Tiramisu only")
  return args.coordinator.run(async () => {
    const predicted = await args.reader.predictEntityKeys({ owner: args.wallet.account.address, count: 1 + count! })
    const key = predicted[0].key
    const draft: SemaphoreGroup = { project: args.project, admin: args.wallet.account.address, key, fromBlock: "0" }
    assertGroup(draft)
    const members = typeof args.members === "function" ? await args.members(draft) : args.members ?? []
    assertMembers(members, args.rules, true)
    if (members.length !== count) throw new MembershipInvalid("Member callback count mismatch")
    const sent = await args.wallet.executeBatch({ creates: [
      { payload: bytes(args.rules), contentType: "application/json", attributes: { project: args.project, type: "veil.group" }, flags: { readonly: true }, expires: ExpirationTime.fromSeconds(args.expires), salt: predicted[0].salt },
      ...members.map((c, i) => ({ payload: bytes({ version: 1 }), contentType: "application/json", attributes: { project: args.project, type: "veil.member", group: key, memberindex: i, commitment: u256(BigInt(c)) }, flags: { readonly: true }, expires: ExpirationTime.fromSeconds(args.expires), salt: predicted[i + 1].salt })),
    ] })
    const receipt = await args.reader.getTransactionReceipt({ hash: sent.txHash })
    if (receipt.status !== "success" || !receipt.to || !same(receipt.to, SYSTEM) || !same(receipt.from, args.wallet.account.address) || sent.createdEntities.length !== predicted.length || sent.createdEntities.some((key, i) => !same(key, predicted[i].key))) throw Object.assign(new VerificationUnavailable("Group write reconciliation required"), { txHash: sent.txHash })
    const group: SemaphoreGroup = { project: args.project, admin: args.wallet.account.address, key, fromBlock: receipt.blockNumber.toString() }
    return { group, txHash: sent.txHash }
  })
}

export async function addSemaphoreMembers(args: { reader: SemaphoreReader; wallet: SemaphoreWriter; coordinator: WriteCoordinator; group: SemaphoreGroup; members: string[]; expires: number }) {
  if (!same(args.wallet.account.address, args.group.admin) || !args.members.length) throw new MembershipInvalid("Group administrator and nonempty members required")
  return args.coordinator.run(async () => {
    const snapshot = await createSemaphoreReader(args.reader, args.group, { trustedRelayers: [args.group.admin] }).getSnapshot(undefined, true)
    assertMembers([...snapshot.members, ...args.members], snapshot.rules, true)
    return args.wallet.executeBatch({ creates: args.members.map((c, i) => ({ payload: bytes({ version: 1 }), contentType: "application/json", attributes: { project: args.group.project, type: "veil.member", group: args.group.key, memberindex: snapshot.members.length + i, commitment: u256(BigInt(c)) }, flags: { readonly: true }, expires: ExpirationTime.fromSeconds(args.expires) })) })
  })
}
