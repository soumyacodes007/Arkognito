// Key-keeper for sealed records (real expiry, packages/sdk/src/seal.ts).
//
// Holds one share of each sealed record's key, in memory only, and:
//   - releases it only while the record is alive on Arkiv (checked on chain at every request),
//     to its on-chain owner (owner-only records) or to anyone (public records), encrypted to the
//     requester's one-time key;
//   - deletes it once the record expires (Arkiv's expiry becomes final), when the owner destroys it,
//     or an hour after deposit if no record ever carried it.
// Shares are never written to disk or to Arkiv, so a restart loses them: that costs availability
// (other keepers cover up to n - t of those), never privacy.
import {
  type ArkivReader,
  KEEPER_VERIFIER,
  type KeeperBind,
  type KeeperDeposit,
  type KeeperDestroy,
  type KeeperRelease,
  type InnerResponse,
  encryptShare,
  fromBase64,
  parseEnvelope,
  readSealHeader,
  verifyOwnershipProof,
  type OwnershipProof,
} from "arkognito"
import { type Address, type Hex, hexToBytes, isHex } from "viem"

type Share = {
  share: Uint8Array
  readers: "owner" | "anyone"
  depositedAt: number
  entityKey?: Hex
  expiresAt?: bigint
}

export type KeeperOptions = {
  address: Address
  reader: Pick<ArkivReader, "getEntity" | "getBlockNumber">
  log: (m: string) => void
  /** Unbound shares are deleted after this long. Default 1 h. */
  unboundTtlMs?: number
  /** Most shares held at once; further deposits are refused. Default 100 000. */
  maxShares?: number
  now?: () => number
}

const isGone = (e: unknown) => /no entity|NoEntityFound|not found|expired/i.test(String((e as Error)?.message ?? e))
const reply = (status: number, body: unknown): InnerResponse => ({ status, body })

export class Keeper {
  readonly #shares = new Map<string, Share>()
  readonly #byEntity = new Map<string, string>()
  deleted = 0
  #timer?: ReturnType<typeof setInterval>

  constructor(private opts: KeeperOptions) {}

  get size() {
    return this.#shares.size
  }

  /** Whether this keeper still holds a share for this record (for tests and health). */
  holds(entityKey: Hex) {
    return this.#byEntity.has(entityKey.toLowerCase())
  }

  #now() {
    return this.opts.now?.() ?? Date.now()
  }

  #drop(sealId: string, why: string) {
    const s = this.#shares.get(sealId)
    if (!s) return
    s.share.fill(0)
    this.#shares.delete(sealId)
    if (s.entityKey) this.#byEntity.delete(s.entityKey.toLowerCase())
    this.deleted++
    this.opts.log(`keeper: deleted a share (${why})`)
  }

  async handle(path: string, body: unknown): Promise<InnerResponse> {
    try {
      switch (path) {
        case "/v1/keeper/deposit":
          return this.#deposit(body as KeeperDeposit)
        case "/v1/keeper/bind":
          return await this.#bind(body as KeeperBind)
        case "/v1/keeper/release":
          return await this.#release(body as KeeperRelease)
        case "/v1/keeper/destroy":
          return await this.#destroy(body as KeeperDestroy)
        default:
          return reply(404, { error: "not found" })
      }
    } catch (e) {
      return reply(500, { error: (e as Error).message })
    }
  }

  #deposit(b: KeeperDeposit): InnerResponse {
    if (!b || !isHex(b.sealId) || hexToBytes(b.sealId).length !== 32) return reply(400, { error: "sealId must be 32 bytes" })
    if (!isHex(b.share)) return reply(400, { error: "share must be hex" })
    const share = hexToBytes(b.share)
    if (share.length !== 33 || share[0] === 0) return reply(400, { error: "share must be 33 bytes (x || 32-byte y)" })
    if (b.readers !== "owner" && b.readers !== "anyone") return reply(400, { error: 'readers must be "owner" or "anyone"' })
    const id = b.sealId.toLowerCase()
    if (this.#shares.has(id)) return reply(409, { error: "a share for this sealId is already held" })
    if (this.#shares.size >= (this.opts.maxShares ?? 100_000)) return reply(503, { error: "keeper is full" })
    this.#shares.set(id, { share, readers: b.readers, depositedAt: this.#now() })
    return reply(202, { ok: true })
  }

  /** Reads the record and returns its seal header, or an error response. Never trusts the caller's word. */
  async #sealOf(entityKey: Hex): Promise<{ sealId: string; expiresAt: bigint; owner: Address } | InnerResponse> {
    if (!isHex(entityKey) || hexToBytes(entityKey).length !== 32) return reply(400, { error: "entityKey must be 32 bytes" })
    let entity
    try {
      entity = await this.opts.reader.getEntity(entityKey)
    } catch (e) {
      if (isGone(e)) return reply(410, { error: "record has expired or does not exist" })
      throw e
    }
    let header
    try {
      const env = parseEnvelope(entity.payload!)
      if (env.enc !== 2) return reply(400, { error: "record is not sealed" })
      header = readSealHeader(fromBase64(env.data))
    } catch {
      return reply(400, { error: "record is not a sealed Arkognito record" })
    }
    if (!header.keepers.some((k) => k.toLowerCase() === this.opts.address.toLowerCase())) {
      return reply(403, { error: "this keeper is not one of the record's keepers" })
    }
    return { sealId: header.sealId.toLowerCase(), expiresAt: entity.expiresAt!, owner: entity.owner! }
  }

  async #bind(b: KeeperBind): Promise<InnerResponse> {
    const seal = await this.#sealOf(b?.entityKey)
    if ("status" in seal) return seal
    const s = this.#shares.get(seal.sealId)
    if (!s) return reply(404, { error: "no share for this record" })
    if (s.entityKey && s.entityKey.toLowerCase() !== b.entityKey.toLowerCase()) return reply(409, { error: "share is bound to another record" })
    s.entityKey = b.entityKey
    s.expiresAt = seal.expiresAt
    this.#byEntity.set(b.entityKey.toLowerCase(), seal.sealId)
    return reply(200, { ok: true, expiresAt: seal.expiresAt.toString() })
  }

  async #proofOk(proof: KeeperRelease["proof"], challenge: string, entityKey: Hex): Promise<string | undefined> {
    if (!proof) return "an ownership proof is required"
    if (proof.entityKey?.toLowerCase() !== entityKey.toLowerCase()) return "proof is for another record"
    const check = await verifyOwnershipProof(proof as OwnershipProof, { challenge, verifier: KEEPER_VERIFIER, client: this.opts.reader as ArkivReader })
    return check.ok ? undefined : check.reason
  }

  async #release(b: KeeperRelease): Promise<InnerResponse> {
    if (!b || !isHex(b.requesterKey) || hexToBytes(b.requesterKey).length !== 32) return reply(400, { error: "requesterKey must be 32 bytes" })
    const seal = await this.#sealOf(b.entityKey)
    if ("status" in seal) {
      // Gone from the chain: the share must go too, whoever asked.
      if (seal.status === 410) {
        const id = this.#byEntity.get(b.entityKey?.toLowerCase())
        if (id) this.#drop(id, "record expired")
      }
      return seal
    }
    const s = this.#shares.get(seal.sealId)
    if (!s) return reply(410, { error: "this keeper holds no share for the record (expired, destroyed or never deposited)" })
    if (!s.entityKey) {
      s.entityKey = b.entityKey
      this.#byEntity.set(b.entityKey.toLowerCase(), seal.sealId)
    }
    s.expiresAt = seal.expiresAt
    if (s.readers === "owner") {
      const why = await this.#proofOk(b.proof, `release:${b.requesterKey.toLowerCase()}`, b.entityKey)
      if (why) return reply(403, { error: why })
    }
    return reply(200, encryptShare(s.share, b.requesterKey))
  }

  async #destroy(b: KeeperDestroy): Promise<InnerResponse> {
    const seal = await this.#sealOf(b?.entityKey)
    if ("status" in seal) return seal
    const why = await this.#proofOk(b.proof, "destroy", b.entityKey)
    if (why) return reply(403, { error: why })
    if (!this.#shares.has(seal.sealId)) return reply(200, { destroyed: false, reason: "no share held" })
    this.#drop(seal.sealId, "destroyed by its owner")
    return reply(200, { destroyed: true })
  }

  /** Deletes shares whose record has expired, and unbound shares past their deadline. */
  async sweep(): Promise<number> {
    const before = this.deleted
    const now = this.#now()
    const ttl = this.opts.unboundTtlMs ?? 60 * 60_000
    let head: bigint | undefined
    for (const [id, s] of [...this.#shares]) {
      if (!s.entityKey) {
        if (now - s.depositedAt > ttl) this.#drop(id, "never bound to a record")
        continue
      }
      head ??= await this.opts.reader.getBlockNumber()
      if (s.expiresAt !== undefined && head < s.expiresAt) continue
      // Due by our last reading: ask the chain, since the record may have been extended.
      try {
        const e = await this.opts.reader.getEntity(s.entityKey)
        if (e.expiresAt !== undefined && e.expiresAt > head) s.expiresAt = e.expiresAt
        else this.#drop(id, "record expired")
      } catch (e) {
        if (isGone(e)) this.#drop(id, "record expired")
        // otherwise the RPC failed: try again next sweep, never release meanwhile (release re-checks)
      }
    }
    return this.deleted - before
  }

  start(everyMs = 10_000) {
    this.#timer = setInterval(() => void this.sweep().catch((e) => this.opts.log(`keeper sweep failed: ${(e as Error).message}`)), everyMs)
  }

  stop() {
    clearInterval(this.#timer)
  }
}
