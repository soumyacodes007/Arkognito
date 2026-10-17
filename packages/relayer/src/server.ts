// Relayer HTTP API (spec/SPEC.md). No request logging, no IP logging (R7).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ExpirationTime } from "@arkiv-network/sdk"
import {
  API_VERSION,
  EXPIRY_BUCKETS,
  type ExtendRequest,
  fromBase64,
  OhttpGateway,
  PAD_BUCKETS,
  TIRAMISU_CHAIN_ID,
  envelopeSigner,
  fromWire,
  nameProblem,
  parseEnvelope,
  type InfoResponse,
  type InnerRequest,
  type InnerResponse,
  type SubmitRequest,
} from "arkognito"
import { type Address, hexToBytes, isAddress, zeroAddress } from "viem"
import { type ArkivClients, WriteQueue } from "./arkiv"
import { type BatchHooks, type BatchItem, Batcher } from "./batcher"
import type { RelayerConfig } from "./config"
import { Heartbeat } from "./heartbeat"
import { Keeper } from "./keeper"

/** Hook for token redemption (Phase 4). Returns fields to add to the batch item, or throws to refuse. */
export type TokenGate = {
  redeem(req: SubmitRequest): Promise<Partial<BatchItem>>
  hooks: BatchHooks
  routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
  /** After-the-fact double-spend scan over the shared spent list (T4). */
  monitor?: { scan(): Promise<string[]>; found(): string[]; start(everyMs?: number): void; stop(): void }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new HttpError(413, "body too large")
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...CORS })
  res.end(status === 204 ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
}

export async function validateSubmission(body: SubmitRequest, relayer: Address, limits: { maxMinAnonymity: number; maxHoldMs: number }): Promise<BatchItem> {
  if (!body || typeof body !== "object") throw new HttpError(400, "missing body")
  const { app, owner, envelope, attributes, expSeconds, minAnonymity, maxHoldMs, inbox } = body
  if (typeof app !== "string" || !app) throw new HttpError(400, "app is required")
  if (typeof owner !== "string" || !isAddress(owner) || owner === zeroAddress) throw new HttpError(400, "owner must be an address")
  if (owner.toLowerCase() === relayer.toLowerCase()) throw new HttpError(400, "owner cannot be the relayer")
  if (typeof envelope !== "string") throw new HttpError(400, "envelope is required")
  const size = new TextEncoder().encode(envelope).length
  if (!(PAD_BUCKETS as readonly number[]).includes(size)) throw new HttpError(400, `envelope must be padded to one of ${PAD_BUCKETS.join("/")} bytes`)
  if (!(EXPIRY_BUCKETS as readonly number[]).includes(expSeconds)) throw new HttpError(400, `expSeconds must be one of ${EXPIRY_BUCKETS.join("/")}`)
  if (minAnonymity !== undefined) {
    if (!Number.isInteger(minAnonymity) || minAnonymity < 1 || minAnonymity > limits.maxMinAnonymity) {
      throw new HttpError(400, `minAnonymity must be 1 to ${limits.maxMinAnonymity}`)
    }
    if (maxHoldMs !== undefined && (!(maxHoldMs > 0) || maxHoldMs > limits.maxHoldMs)) {
      throw new HttpError(400, `maxHoldMs must be at most ${limits.maxHoldMs}`)
    }
  }
  let typed
  try {
    typed = fromWire(attributes)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  if (Object.keys(typed).length > 32) throw new HttpError(400, "too many attributes")
  for (const name of Object.keys(typed)) {
    const p = nameProblem(name)
    if (p) throw new HttpError(400, p)
  }
  if (!("project" in typed)) throw new HttpError(400, "records must carry a project attribute")
  let env
  try {
    env = parseEnvelope(envelope)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  if (env.app !== app || env.exp !== expSeconds) throw new HttpError(400, "envelope app/expiry do not match the request")
  // Refuse junk early: only records the owner actually signed are worth gas. An inbox record is
  // signed by a key derived for its recipient, which only the recipient can check.
  let signer
  try {
    signer = await envelopeSigner(env, typed)
  } catch {
    throw new HttpError(400, "envelope signature is malformed")
  }
  if (inbox !== undefined && inbox !== true) throw new HttpError(400, "inbox must be true or absent")
  if (!inbox && signer.toLowerCase() !== owner.toLowerCase()) throw new HttpError(400, "envelope is not signed by owner")
  if (inbox && signer.toLowerCase() === owner.toLowerCase()) throw new HttpError(400, "an inbox record is not signed by its owner")
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    owner,
    envelope,
    attributes: typed,
    expSeconds,
    receivedAt: now,
    inbox: inbox || undefined,
    // Sealed records (real expiry): anyone may extend the lease, nobody may change the content.
    flags: env.enc === 2 ? { permissionlessExtension: true, readonly: true } : undefined,
    minAnonymity: minAnonymity && minAnonymity > 1 ? minAnonymity : undefined,
    holdUntil: minAnonymity && minAnonymity > 1 ? now + Math.min(maxHoldMs ?? limits.maxHoldMs, limits.maxHoldMs) : undefined,
  }
}

/**
 * Requests per minute per source address, kept in memory only and never written or logged. Used
 * only when tokens are off; with tokens the token is the rate limit. Requests that arrive through
 * an OHTTP relay all share the relay's address, so they are not counted here.
 */
class RateLimiter {
  #hits = new Map<string, number[]>()
  constructor(private perMinute: number) {}
  allow(source: string): boolean {
    const now = Date.now()
    const recent = (this.#hits.get(source) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= this.perMinute) {
      this.#hits.set(source, recent)
      return false
    }
    recent.push(now)
    this.#hits.set(source, recent)
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.every((t) => now - t >= 60_000)) this.#hits.delete(k)
    return true
  }
}

export function startRelayer(cfg: RelayerConfig, arkiv: ArkivClients, gate?: TokenGate) {
  const log = (m: string) => console.log(`[${cfg.name}] ${m}`)
  const writer = new WriteQueue()
  const batcher = new Batcher(
    arkiv,
    writer,
    { minBatch: cfg.minBatch, maxBatch: cfg.maxBatch, maxWaitMs: cfg.maxWaitMs, minIntervalBlocks: cfg.minIntervalBlocks, coverMinBatch: cfg.coverMinBatch, evil: cfg.evil, log },
    gate?.hooks,
  )
  const limiter = new RateLimiter(cfg.ratePerMinute)
  const keeper = cfg.keeper ? new Keeper({ address: arkiv.address, reader: arkiv.publicClient as never, log }) : undefined
  let gateway: OhttpGateway | undefined
  let heartbeat: Heartbeat | undefined
  let balance = 0n

  const info = (): InfoResponse => ({
    address: arkiv.address,
    version: API_VERSION,
    chainId: TIRAMISU_CHAIN_ID,
    minBatch: cfg.minBatch,
    maxWaitMs: cfg.maxWaitMs,
    minIntervalBlocks: cfg.minIntervalBlocks,
    tokensRequired: cfg.requireTokens,
    issuer: cfg.issuerAddress,
    issuerUrl: cfg.issuerUrl,
    maxMinAnonymity: cfg.maxMinAnonymity,
    maxHoldMs: cfg.maxHoldMs,
    ohttpKey: gateway?.publicKey,
    coverMinBatch: cfg.coverMinBatch || undefined,
    keeper: keeper ? true : undefined,
  })

  /** The API itself, shared by direct HTTP and by requests unwrapped from OHTTP. */
  async function dispatch(method: string, path: string, body: unknown, source: { ip?: string; ohttp: boolean }): Promise<InnerResponse> {
    try {
      if (method === "GET" && path === "/v1/info") return { status: 200, body: info() }
      if (method === "GET" && path === "/healthz") {
        return {
          status: 200,
          body: {
            ok: true,
            address: arkiv.address,
            queue: batcher.queue.length,
            batches: batcher.batches,
            lastFlushBlock: batcher.lastFlushBlock.toString(),
            heartbeat: heartbeat?.key,
            lastBeat: heartbeat?.lastBeat,
            balanceGlm: Number(balance) / 1e18,
            doubleSpendsDetected: gate?.monitor?.found().length ?? 0,
          },
        }
      }
      if (method === "POST" && path === "/v1/records") {
        if (!cfg.requireTokens && !source.ohttp && source.ip && !limiter.allow(source.ip)) throw new HttpError(429, "too many requests")
        if (batcher.queue.length >= cfg.maxQueue) throw new HttpError(503, "queue is full; try another relayer")
        const req = body as SubmitRequest
        const item = await validateSubmission(req, arkiv.address, cfg)
        if (cfg.requireTokens) {
          if (!gate) throw new HttpError(500, "tokens required but no token gate configured")
          if (!req.token) throw new HttpError(402, "a rate-limit token is required")
          try {
            Object.assign(item, await gate.redeem(req))
          } catch (e) {
            throw new HttpError(403, (e as Error).message)
          }
        }
        batcher.enqueue(item)
        return { status: 202, body: { id: item.id } }
      }
      if (method === "POST" && path.startsWith("/v1/keeper/")) {
        if (!keeper) return { status: 404, body: { error: "this relayer is not a key-keeper" } }
        if (path === "/v1/keeper/deposit" && !source.ohttp && source.ip && !limiter.allow(source.ip)) throw new HttpError(429, "too many requests")
        return await keeper.handle(path, body)
      }
      if (method === "POST" && path === "/v1/extend") return await extend(body as ExtendRequest)
      const m = path.match(/^\/v1\/records\/([0-9a-f-]{36})$/)
      if (method === "GET" && m) {
        const s = batcher.status.get(m[1])
        if (!s) return { status: 404, body: { error: "unknown id" } }
        const { at: _at, ...rest } = s
        if (rest.state === "queued") rest.position = batcher.queue.findIndex((q) => q.id === rest.id)
        return { status: 200, body: rest }
      }
      return { status: 404, body: { error: "not found" } }
    } catch (e) {
      return { status: e instanceof HttpError ? e.status : 500, body: { error: (e as Error).message } }
    }
  }

  /**
   * Extends a sealed record this relayer wrote (created with permissionless extension). The new
   * expiry counts from now. With tokens on, a token pays, and its spent marker lands in the same
   * transaction as the extension.
   */
  async function extend(req: ExtendRequest): Promise<InnerResponse> {
    if (!req || typeof req.entityKey !== "string") throw new HttpError(400, "entityKey is required")
    if (!(EXPIRY_BUCKETS as readonly number[]).includes(req.expSeconds)) throw new HttpError(400, `expSeconds must be one of ${EXPIRY_BUCKETS.join("/")}`)
    let entity
    try {
      entity = await arkiv.publicClient.getEntity(req.entityKey)
    } catch {
      throw new HttpError(410, "record has expired or does not exist")
    }
    if (entity.creator?.toLowerCase() !== arkiv.address.toLowerCase()) throw new HttpError(400, "this relayer did not write that record")
    let sealed = false
    try {
      const env = parseEnvelope(entity.payload!)
      sealed = env.enc === 2 && env.app === req.app
    } catch {
      // not an envelope
    }
    if (!sealed) throw new HttpError(400, "only sealed records of this app can be extended")
    let creates: Partial<BatchItem>["sideCreates"] = []
    if (cfg.requireTokens) {
      if (!gate) throw new HttpError(500, "tokens required but no token gate configured")
      if (!req.token) throw new HttpError(402, "a rate-limit token is required")
      try {
        creates = (await gate.redeem({ app: req.app, token: req.token } as SubmitRequest)).sideCreates ?? []
      } catch (e) {
        throw new HttpError(403, (e as Error).message)
      }
    }
    const res = await writer.run(() =>
      arkiv.walletClient.executeBatch({ creates, extensions: [{ entityKey: req.entityKey, expires: ExpirationTime.fromSeconds(req.expSeconds) }] }),
    )
    const after = await arkiv.publicClient.getEntity(req.entityKey)
    return { status: 200, body: { txHash: res.txHash, expiresAt: after.expiresAt?.toString() } }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x")
      if (req.method === "OPTIONS") return send(res, 204, {})
      if (req.method === "POST" && url.pathname === "/v1/ohttp") {
        if (!gateway) throw new HttpError(404, "OHTTP is off on this relayer")
        let opened: Awaited<ReturnType<OhttpGateway["open"]>>
        try {
          opened = await gateway.open(new Uint8Array(await readBody(req, 128 * 1024)))
        } catch {
          throw new HttpError(400, "cannot open OHTTP request")
        }
        const inner: InnerRequest = opened.request
        const answer = await dispatch(inner.method, inner.path, inner.body, { ohttp: true })
        const plain = JSON.parse(JSON.stringify(answer, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as InnerResponse
        res.writeHead(200, { "content-type": "message/ohttp-res", ...CORS })
        return res.end(Buffer.from(await opened.seal(plain)))
      }
      if (gate?.routes && (await gate.routes(req, res, url))) return
      let body: unknown
      if (req.method === "POST") {
        try {
          body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"))
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, "body is not JSON")
        }
      }
      const answer = await dispatch(req.method ?? "GET", url.pathname, body, { ip: req.socket.remoteAddress, ohttp: false })
      send(res, answer.status, answer.body)
    } catch (e) {
      send(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message })
    }
  })

  async function checkBalance() {
    try {
      balance = await arkiv.publicClient.getBalance({ address: arkiv.address })
      if (Number(balance) / 1e18 < cfg.lowBalanceGlm) log(`LOW BALANCE: ${Number(balance) / 1e18} GLM, fund ${arkiv.address} (R6)`)
    } catch {
      // next minute
    }
  }

  let balanceTimer: ReturnType<typeof setInterval> | undefined
  return {
    batcher,
    writer,
    server,
    get heartbeat() {
      return heartbeat
    },
    get ohttpKey() {
      return gateway?.publicKey
    },
    keeper,
    async listen() {
      // The gateway key derives from the relayer's own key, so it is stable across restarts.
      if (cfg.ohttp) gateway = await OhttpGateway.fromSeed(hexToBytes(cfg.privateKey))
      heartbeat = new Heartbeat(arkiv, writer, { url: cfg.publicUrl, minBatch: cfg.minBatch, tokensRequired: cfg.requireTokens, ohttpKey: gateway?.publicKey }, log)
      await checkBalance()
      balanceTimer = setInterval(() => void checkBalance(), 60_000)
      batcher.start()
      keeper?.start(cfg.keeperSweepMs)
      if (cfg.requireTokens) gate?.monitor?.start()
      if (cfg.heartbeat) await heartbeat.start(cfg.heartbeatEveryMs)
      await new Promise<void>((r) => server.listen(cfg.port, r))
      log(`listening on :${cfg.port} as ${arkiv.address} (k=${cfg.minBatch}, maxWait=${cfg.maxWaitMs}ms, cover=${cfg.coverMinBatch || "off"}, keeper=${cfg.keeper ? "on" : "off"}, ohttp=${!!gateway}, evil=${cfg.evil})`)
    },
    async close() {
      clearInterval(balanceTimer)
      batcher.stop()
      keeper?.stop()
      heartbeat?.stop()
      gate?.monitor?.stop()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
