// createPrivateClient: the builder-facing API (PRD §4).
import { type AttributeInputs, createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Address, type Hex, type PublicClient, http } from "viem"
import { assertNodeSafeNames, toWire } from "./attrs.ts"
import { type CheckWarning, checkRarity, checkRecord } from "./check.ts"
import { type DeterminismMode, type DeterminismStore, KeyVault, type SigningWallet, scopeRef } from "./derive.ts"
import { heartbeatRelayers } from "./discovery.ts"
import { envelopeDigest, expiryBucket, expirySeconds, fromBase64, sealEnvelope } from "./envelope.ts"
import { sealInbox } from "./inbox.ts"
import type { PasskeyOptions } from "./passkey.ts"
import { type InnerResponse, ohttpCall } from "./ohttp.ts"
import { type OwnershipProof, signOwnershipProof } from "./proof.ts"
import type { InfoResponse, StatusResponse, SubmitRequest, TokenRedemption } from "./protocol.ts"
import { type AppEntry, type ArkivReader, type FullRecord, type VerifiedRecord, fetchBatches, fetchProject, listApp, verifyRecord } from "./reader.ts"
import { type TokenStore, TokenWallet } from "./tokens.ts"
import type { ArkognitoSigner, KeyRef, Vault } from "./vault.ts"
import { WorkerVault } from "./worker-vault.ts"

export type ArkognitoCreateParams = {
  payload: Uint8Array
  contentType: string
  attributes?: AttributeInputs
  /** `ExpirationTime.fromHours(...)` etc., or seconds. Rounded up to a bucket (F1). */
  expires: { minLifetime: bigint } | number
  /** Records in one scope share one owner address, on purpose. */
  scope?: string
  /** Encrypt the payload so only you can read it (A6: expiry does not erase history). */
  encrypt?: boolean
}

export type ArkognitoCreateResult = {
  entityKey: Hex
  owner: Address
  txHash?: Hex
  relayer: string
  /** Records in the same batch, including this one and any cover records (B2: "you were 1 of N"). */
  batchSize?: number
  /** How many of `batchSize` were cover records added by the relayer (B5). Outsiders cannot tell which. */
  cover?: number
  /** True when the relayer failed to answer but the record turned out to have landed (no duplicate written). */
  recovered?: boolean
  warnings: CheckWarning[]
}

export type MyRecord = VerifiedRecord & {
  ref: KeyRef
  /** Same as entityKey, so code written against SDK entities keeps working. */
  key: Hex
  /** The payload, decrypted when the record was written with `encrypt: true`. */
  toText(): string
  toJson(): any
}

/** Supplies one rate-limit token per write attempt (Phase 4). */
export type TokenSource = { take(app: string, relayer: InfoResponse): Promise<TokenRedemption | undefined> }

export type PrivateClientOptions = {
  app: string
  /** Value of the `project` attribute on this app's records. Defaults to `app`. */
  project?: string
  /** Relayer URLs. Omit to discover live relayers from their heartbeat entities on Arkiv (R8). */
  relayers?: string[]
  /** Wallet that signs the derivation message once. One of `wallet`, `passkey` or `vault`. */
  wallet?: SigningWallet
  /**
   * Sign in with an existing passkey instead of a wallet (WebAuthn PRF): one biometric or PIN prompt.
   * Create the passkey first with `WorkerVault.createPasskey` (or `KeyVault.createPasskey`), which
   * returns the recovery code to show the user.
   */
  passkey?: true | PasskeyOptions
  vault?: Vault
  /**
   * Also look for records others wrote to your inbox address (`sendTo`). Costs one elliptic-curve
   * multiplication per record in the app when listing, so it is off by default.
   */
  inbox?: boolean
  /**
   * When the app has at most this many records, reading your records downloads all of them, so the
   * RPC provider learns nothing about which are yours. Above it, your batches plus cover batches are
   * fetched (D1). Default 500; 0 turns it off.
   */
  fetchAllUnder?: number
  /**
   * When to check that the wallet signs deterministically (K1). Default "first-use": two prompts
   * the first time this device sees the wallet for this app, one prompt afterwards.
   */
  verifyDeterminism?: DeterminismMode
  /** Where "first-use" remembers verified wallets. Default: localStorage, else memory. */
  determinismStore?: DeterminismStore
  /**
   * Keep derived keys in a Web Worker so the page never holds them (D3). Default: on in browsers,
   * off elsewhere. If the worker cannot start, the client warns and keeps keys in this thread.
   */
  isolateKeys?: boolean
  /**
   * Send every relayer call through this Oblivious HTTP relay (R7). The relay sees your IP but not
   * the request; the relayer sees the request but not your IP. Relayers' gateway keys are read from
   * their heartbeat entities on Arkiv.
   */
  ohttpRelay?: string
  /** Arkiv reader. Defaults to a public Tiramisu client. */
  publicClient?: ArkivReader & Partial<Pick<PublicClient, "getCode">>
  /** Random delay before each submission, in ms (B1). Default [0, 20000]. */
  delayMs?: [number, number]
  /**
   * Smallest batch a record may land in (B2). The relayer holds the record until enough others
   * arrive, up to `maxHoldMs`, and fails it rather than write it in a smaller batch. Default 1.
   */
  minAnonymity?: number
  maxHoldMs?: number
  /** Give up on a relayer when its queue has not moved for this long (R3). Default: 3 batch windows. */
  inclusionTimeoutMs?: number
  /** Status polling interval, ms. */
  pollMs?: number
  /** Refuse to write when `check()` raises a warning. Default false (warn only). */
  strict?: boolean
  /** Warn when fewer than this many existing records share a record's attribute values (F3). 0 turns it off. Default 3. */
  rarityK?: number
  /** Extra batches fetched alongside your own when reading your records, as cover (D1). Default 2. */
  coverBatches?: number
  /**
   * Rate-limit tokens. "auto" (default): when a relayer requires tokens, fetch the day's tokens at
   * session start, never at write time (T2). Or pass your own TokenSource.
   */
  tokens?: TokenSource | "auto"
  /**
   * Who asks the issuer for tokens in auto mode. "derived" (default): an address derived from your
   * Arkognito root for this app, so asking opens no wallet prompt and the issuer never sees your
   * wallet. "wallet": the wallet signs each request (one more prompt), for issuers that key quotas
   * to known wallets.
   */
  tokenIdentity?: "derived" | "wallet"
  /** Where auto mode keeps unspent tokens. Defaults to memory; use browserTokenStore() to keep them across sessions. */
  tokenStore?: TokenStore
  /** One-time attestation code, for issuers that require one before handing out tokens (T5). */
  tokenAttestation?: string
  /** Count a record as the app's only if a known relayer created it. Default false: any creator, since every record is verified anyway. */
  trustedRelayersOnly?: boolean
  fetch?: typeof fetch
}

type Relayer = { url: string; info?: InfoResponse; bad: boolean; ohttpKey?: Hex }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lower = (a: string) => a.toLowerCase()
const dec = new TextDecoder()

export class ArkognitoError extends Error {}

export async function createPrivateClient(opts: PrivateClientOptions) {
  const app = opts.app
  const project = opts.project ?? opts.app
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const reader = opts.publicClient ?? (createPublicClient({ chain: tiramisu, transport: http() }) as unknown as ArkivReader)
  const vault: Vault = opts.vault ?? (await openVault())

  async function openVault(): Promise<Vault> {
    const browser = typeof window !== "undefined" && typeof Worker !== "undefined"
    if (opts.passkey) {
      const pk = opts.passkey === true ? {} : opts.passkey
      if (opts.isolateKeys ?? browser) {
        try {
          return await WorkerVault.fromPasskey(app, { ...pk, worker: WorkerVault.spawn() })
        } catch (e) {
          if (!(e instanceof Error) || !/Worker/.test(e.message)) throw e
        }
      }
      return KeyVault.fromPasskey(app, pk)
    }
    if (!opts.wallet) throw new ArkognitoError("pass `wallet`, `passkey` or `vault`")
    const derivation = {
      publicClient: reader as unknown as PublicClient,
      verifyDeterminism: opts.verifyDeterminism,
      determinismStore: opts.determinismStore,
    }
    if (opts.isolateKeys ?? browser) {
      let worker: Worker | undefined
      try {
        worker = WorkerVault.spawn()
      } catch (e) {
        console.warn(`arkognito: could not start the key worker (${(e as Error).message}); keys stay in this thread`)
      }
      if (worker) return WorkerVault.fromWallet(opts.wallet, app, { ...derivation, worker })
    }
    return KeyVault.fromWallet(opts.wallet, app, derivation)
  }

  // ---- relayers, reached directly or through an OHTTP relay ----------------------------------
  const heartbeats = await heartbeatRelayers(reader).catch(() => [])
  const norm = (u: string) => u.replace(/\/$/, "")
  const urls = [...new Set((opts.relayers ?? heartbeats.map((h) => h.url)).map(norm))]
  if (urls.length === 0) throw new ArkognitoError("no relayer: pass `relayers` or run one (none is live on Arkiv)")
  const relayers: Relayer[] = urls.map((url) => ({ url, bad: false }))

  async function call(r: Relayer, method: "GET" | "POST", path: string, body?: unknown): Promise<InnerResponse> {
    if (opts.ohttpRelay) {
      if (!r.ohttpKey) throw new ArkognitoError(`${r.url} publishes no OHTTP gateway key, so it cannot be reached privately`)
      return ohttpCall(opts.ohttpRelay, r.url, r.ohttpKey, { method, path, body }, fetchFn)
    }
    const res = await fetchFn(`${r.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // keep the text
    }
    return { status: res.status, body: parsed }
  }

  await Promise.all(
    relayers.map(async (r) => {
      if (!opts.ohttpRelay) {
        try {
          const res = await call(r, "GET", "/v1/info")
          r.info = res.status === 200 ? (res.body as InfoResponse) : undefined
        } catch {
          r.info = undefined
        }
        return
      }
      // Through OHTTP the gateway key comes from a heartbeat. Anyone can publish a heartbeat that
      // claims any URL, so try every key claimed for this URL: only the real relayer can decrypt,
      // and its answer must name the address that created that heartbeat (squatting resistance).
      for (const hb of heartbeats.filter((h) => norm(h.url) === r.url && h.ohttpKey)) {
        try {
          r.ohttpKey = hb.ohttpKey
          const res = await call(r, "GET", "/v1/info")
          const info = res.body as InfoResponse
          if (res.status === 200 && lower(info.address) === lower(hb.address)) {
            r.info = info
            return
          }
        } catch {
          // not this key
        }
      }
      r.ohttpKey = undefined
      r.info = undefined
    }),
  )
  const relayerAddresses = (): Address[] => [...new Set(relayers.flatMap((r) => (r.info ? [r.info.address] : [])))]

  // ---- rate-limit tokens (T2) --------------------------------------------------------------
  let tokenSource: TokenSource | undefined = typeof opts.tokens === "object" ? opts.tokens : undefined
  const issuing = relayers.find((r) => r.info?.tokensRequired && r.info.issuer && r.info.issuerUrl)?.info
  const tokenIdentity = opts.tokenIdentity ?? "derived"
  if (!tokenSource && (opts.tokens ?? "auto") === "auto" && issuing && (tokenIdentity === "derived" || opts.wallet)) {
    const tw = new TokenWallet({
      ...(tokenIdentity === "derived" ? { identity: vault } : { wallet: opts.wallet }),
      reader,
      issuer: issuing.issuer!,
      issuerUrl: issuing.issuerUrl!,
      store: opts.tokenStore,
      attestation: opts.tokenAttestation,
      fetch: fetchFn,
    })
    // Fetched at session start, not at write time, so issuance and redemption are apart in time.
    let prefetch: Promise<unknown> = Promise.resolve()
    if (tw.available(app) === 0) prefetch = tw.acquire(app, 5).catch(() => tw.acquire(app, 1).catch(() => undefined))
    const inner = tw.source()
    tokenSource = {
      take: async (a, info) => {
        await prefetch
        return inner.take(a, info)
      },
    }
  }

  // ---- the app's records, as of one block, without payloads (D1) ------------------------------
  let listing: { at: number; entries: AppEntry[] } | undefined
  /** How the last read fetched payloads: the whole app, or batches plus cover. */
  let lastRead: "all" | "batches" | undefined
  async function appIndex(maxAgeMs = 30_000): Promise<AppEntry[]> {
    if (!listing || Date.now() - listing.at > maxAgeMs) {
      listing = { at: Date.now(), entries: await listApp(reader, project, opts.trustedRelayersOnly ? relayerAddresses() : []) }
    }
    return listing.entries
  }

  /**
   * Full records for these entries. Small app: every record of it, so nothing says which are ours.
   * Otherwise: whole batches plus random cover batches (D1).
   */
  async function fetchCovered(mine: AppEntry[]): Promise<Map<string, FullRecord>> {
    const all = listing?.entries ?? []
    if (all.length > 0 && all.length <= (opts.fetchAllUnder ?? 500)) {
      lastRead = "all"
      const records = await fetchProject(reader, project)
      return new Map(records.map((r) => [lower(r.key), r]))
    }
    lastRead = "batches"
    const key = (b: { block: bigint; creator: Address }) => `${b.block}|${lower(b.creator)}`
    const wanted = new Map<string, { block: bigint; creator: Address }>()
    for (const m of mine) wanted.set(key({ block: m.createdAt, creator: m.creator }), { block: m.createdAt, creator: m.creator })
    const others = [...new Map(all.map((e) => [key({ block: e.createdAt, creator: e.creator }), { block: e.createdAt, creator: e.creator }])).values()].filter(
      (b) => !wanted.has(key(b)),
    )
    for (let i = 0; i < (opts.coverBatches ?? 2) && others.length; i++) {
      const [b] = others.splice(Math.floor(Math.random() * others.length), 1)
      wanted.set(key(b), b)
    }
    const batches = [...wanted.values()].sort(() => Math.random() - 0.5)
    const records = await fetchBatches(reader, project, batches)
    return new Map(records.map((r) => [lower(r.key), r]))
  }

  // ---- one write at a time per user, across this client and across browser tabs (B4) ----------
  // The lock is per user, not per app: a server writing for many users in one process must not
  // serialise them. Its name comes from the user's own vault and never leaves this machine.
  const lockName = `arkognito:${app}:${(await vault.addressOf(scopeRef("arkognito/write-lock"))).slice(2, 18)}`
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const locked = () => {
      const locks = (globalThis as { navigator?: { locks?: { request(n: string, f: () => Promise<T>): Promise<T> } } }).navigator?.locks
      return locks ? locks.request(lockName, fn) : fn()
    }
    const run = chain.then(locked, locked)
    chain = run.catch(() => undefined)
    return run
  }

  async function submitAndWait(r: Relayer, body: SubmitRequest): Promise<StatusResponse> {
    const res = await call(r, "POST", "/v1/records", body)
    if (res.status !== 202) throw new ArkognitoError(`relayer refused: ${res.status} ${JSON.stringify(res.body)}`)
    const { id } = res.body as { id: string }
    const info = r.info!
    const timeout = opts.inclusionTimeoutMs ?? 3 * (info.maxWaitMs + info.minIntervalBlocks * 2000) + 30_000
    let deadline = Date.now() + Math.max(timeout, body.maxHoldMs ?? 0)
    let lastPosition = Number.POSITIVE_INFINITY
    while (Date.now() < deadline) {
      await sleep(opts.pollMs ?? 2000)
      try {
        const s = (await call(r, "GET", `/v1/records/${id}`)).body as StatusResponse
        if (s.state !== "queued") return s
        // A queue that is moving is busy, not censoring: restart the clock on progress (R3).
        if (s.position !== undefined && s.position < lastPosition) {
          lastPosition = s.position
          deadline = Date.now() + timeout
        }
      } catch {
        // relayer briefly unreachable; keep polling until the deadline
      }
    }
    return { id, state: "failed", error: "timed out waiting for inclusion" }
  }

  /** Finds a record by its tag in a fresh listing and verifies it: used to confirm a write without naming the record. */
  async function findOwn(tag: string, owner: Address, signer?: Address): Promise<FullRecord | undefined> {
    const entry = (await appIndex(0)).find((e) => e.tag === tag)
    if (!entry) return undefined
    const full = (await fetchCovered([entry])).get(lower(entry.key))
    if (!full) return undefined
    const v = await verifyRecord(full, { app, owner, signer })
    return v.ok ? full : undefined
  }

  function check(params: Pick<ArkognitoCreateParams, "attributes" | "expires" | "payload">): CheckWarning[] {
    return checkRecord(params)
  }

  /** Warns when fewer than `k` existing records share these attribute values (F3). */
  async function rarity(attributes: AttributeInputs | undefined, k = opts.rarityK ?? 3): Promise<CheckWarning[]> {
    if (!k) return []
    return checkRarity(attributes, await appIndex(), k)
  }

  async function createEntity(params: ArkognitoCreateParams): Promise<ArkognitoCreateResult> {
    const warnings = [...check(params), ...(await rarity(params.attributes).catch(() => []))]
    if (opts.strict && warnings.length) {
      throw new ArkognitoError(`check() refused this record: ${warnings.map((w) => w.message).join("; ")}`)
    }
    const expSeconds = expiryBucket(expirySeconds(params.expires))

    return serial(async () => {
      const key = params.scope ? await vault.scopeRecord(params.scope) : await vault.newRecord()
      const signer = await vault.signer(key.ref)
      const payload = params.encrypt ? await vault.encrypt(key.ref, params.payload) : params.payload
      return submit({ owner: key.address, tag: key.tag, signer, payload, encrypted: !!params.encrypt, inbox: false }, params, expSeconds, warnings)
    })
  }

  /**
   * Writes a record for someone else: owned by a one-time address only the holder of `inboxAddress`
   * controls, readable only by them, and found by their `myEntities()` when they enable `inbox`.
   * Always encrypted. You cannot read it back or prove ownership of it.
   */
  async function sendTo(inboxAddress: string, params: Omit<ArkognitoCreateParams, "scope" | "encrypt">): Promise<ArkognitoCreateResult> {
    const warnings = [...check(params), ...(await rarity(params.attributes).catch(() => []))]
    if (opts.strict && warnings.length) {
      throw new ArkognitoError(`check() refused this record: ${warnings.map((w) => w.message).join("; ")}`)
    }
    const expSeconds = expiryBucket(expirySeconds(params.expires))
    let sealedKey: ReturnType<typeof sealInbox>
    try {
      sealedKey = sealInbox(inboxAddress, app)
    } catch (e) {
      throw new ArkognitoError((e as Error).message)
    }
    const acct = sealedKey.envelopeSigner
    const signer: ArkognitoSigner = {
      address: acct.address,
      signEnvelope: (body, attributes) => acct.signMessage({ message: { raw: envelopeDigest(body, attributes) } }),
      signProof: () => Promise.reject(new ArkognitoError("an inbox record's sender cannot prove ownership")),
    }
    return serial(() =>
      submit({ owner: sealedKey.owner, tag: sealedKey.tag, signer, payload: sealedKey.encrypt(params.payload), encrypted: true, inbox: true }, params, expSeconds, warnings),
    )
  }

  type Prepared = { owner: Address; tag: string; signer: ArkognitoSigner; payload: Uint8Array; encrypted: boolean; inbox: boolean }

  /** Seals, delays, submits to the first relayer that writes it, and verifies the result (R1–R4). */
  async function submit(
    key: Prepared,
    params: Pick<ArkognitoCreateParams, "attributes" | "contentType">,
    expSeconds: number,
    warnings: CheckWarning[],
  ): Promise<ArkognitoCreateResult> {
    const attributes: AttributeInputs = { ...params.attributes, project, vtag: key.tag }
    try {
      assertNodeSafeNames(attributes)
    } catch (e) {
      throw new ArkognitoError((e as Error).message)
    }
    const signer = key.signer
    const expectSigner = key.inbox ? signer.address : undefined
    const sealed = await sealEnvelope({ signer, app, payload: key.payload, contentType: params.contentType, attributes, expSeconds, encrypted: key.encrypted })
    const [lo, hi] = opts.delayMs ?? [0, 20_000]
    await sleep(lo + Math.random() * Math.max(0, hi - lo))

    const failures: string[] = []
    const order = [...relayers.filter((r) => !r.bad && r.info), ...relayers.filter((r) => r.bad && r.info)]
    if (order.length === 0) throw new ArkognitoError("no relayer is reachable")
    const done = (entity: FullRecord, r: Relayer | undefined, s?: StatusResponse, recovered = false): ArkognitoCreateResult => {
      if (listing) listing.entries.push({ key: entity.key, owner: entity.owner, creator: entity.creator, createdAt: entity.createdAt, attributes: entity.attributes, tag: key.tag })
      return { entityKey: entity.key, owner: key.owner, txHash: s?.txHash, relayer: r?.url ?? "", batchSize: s?.batchSize, cover: s?.cover, recovered, warnings }
    }
    for (const r of order) {
      try {
        const token = await tokenSource?.take(app, r.info!)
        const minAnonymity = opts.minAnonymity && opts.minAnonymity > 1 ? opts.minAnonymity : undefined
        const status = await submitAndWait(r, {
          app,
          owner: key.owner,
          envelope: sealed.text,
          attributes: toWire(attributes),
          expSeconds,
          token,
          minAnonymity,
          maxHoldMs: minAnonymity ? (opts.maxHoldMs ?? 10 * 60_000) : undefined,
          ...(key.inbox ? { inbox: true } : {}),
        })
        if (status.state !== "written" || !status.entityKey || !status.block) {
          // R4: the relayer may have written it and then failed to say so. Check before retrying elsewhere.
          const landed = await findOwn(key.tag, key.owner, expectSigner)
          if (landed) return done(landed, undefined, undefined, true)
          failures.push(`${r.url}: ${status.error ?? status.state}`)
          continue
        }
        // R1/R2: trust nothing the relayer says. Read the whole batch back (never just our key) and verify.
        // The RPC node can trail the relayer's by a block or two: read again before calling it a lie.
        let entity: FullRecord | undefined
        for (let attempt = 0; attempt < 6 && !entity; attempt++) {
          if (attempt) await sleep(2000)
          const batch = await fetchBatches(reader, project, [{ block: BigInt(status.block), creator: r.info!.address }])
          entity = batch.find((e) => lower(e.key) === lower(status.entityKey!))
        }
        const v = entity ? await verifyRecord(entity, { app, owner: key.owner, signer: expectSigner, relayers: [r.info!.address] }) : { ok: false as const, reason: "record is not in the batch the relayer named" }
        if (!v.ok) {
          r.bad = true
          failures.push(`${r.url} misbehaved: ${v.reason}`)
          continue
        }
        return done(entity!, r, status)
      } catch (e) {
        failures.push(`${r.url}: ${(e as Error).message}`)
      }
    }
    throw new ArkognitoError(`every relayer failed: ${failures.join(" | ")}`)
  }

  const refByKey = new Map<string, KeyRef>()

  /**
   * Every record of yours: download the app's tags, open the ones that are yours locally (or in the
   * key worker), then fetch only whole batches, with cover batches, to verify them (D1).
   * `where` filters on attribute values, also locally.
   */
  async function myEntities(o: { refresh?: boolean; where?: Record<string, string | number | boolean> } = {}): Promise<MyRecord[]> {
    const entries = await appIndex(o.refresh === false ? 30_000 : 0)
    const tagged = entries.filter((e) => e.tag)
    const refs = await vault.openTags(tagged.map((e) => e.tag!))
    if (opts.inbox) {
      const rest = tagged.flatMap((e, i) => (refs[i] ? [] : [i]))
      const inboxRefs = await vault.openInbox(rest.map((i) => tagged[i].tag!))
      rest.forEach((i, j) => {
        if (inboxRefs[j]) refs[i] = inboxRefs[j]
      })
    }
    const mine: { entry: AppEntry; ref: KeyRef }[] = []
    tagged.forEach((e, i) => {
      if (refs[i]) mine.push({ entry: e, ref: refs[i]! })
    })
    if (mine.length === 0) return []
    const full = await fetchCovered(mine.map((m) => m.entry))
    const out: MyRecord[] = []
    for (const m of mine) {
      const entity = full.get(lower(m.entry.key))
      if (!entity) continue
      const owner = await vault.addressOf(m.ref)
      const signer = m.ref.kind === "inbox" ? await vault.envelopeSignerOf(m.ref) : undefined
      const v = await verifyRecord(entity, { app, owner, signer })
      if (!v.ok) continue
      const matches = Object.entries(o.where ?? {}).every(([k, want]) => String(v.record.attributes?.[k]?.value) === String(want))
      if (!matches) continue
      const data = v.record.envelope.enc === 1 ? await vault.decrypt(m.ref, fromBase64(v.record.envelope.data)).catch(() => undefined) : v.record.data
      if (!data) continue
      refByKey.set(lower(v.record.entityKey), m.ref)
      const text = () => dec.decode(data)
      out.push({ ...v.record, data, ref: m.ref, key: v.record.entityKey, toText: text, toJson: () => JSON.parse(text()) })
    }
    // Newest first, like an Arkiv query.
    return out.sort((a, b) => Number((b.createdAt ?? 0n) - (a.createdAt ?? 0n)))
  }

  async function proveOwnership(entityKey: Hex, args: { challenge: string; verifier: string; ttlSeconds?: number }): Promise<OwnershipProof> {
    let ref = refByKey.get(lower(entityKey))
    if (!ref) {
      await myEntities()
      ref = refByKey.get(lower(entityKey))
    }
    if (!ref) throw new ArkognitoError(`${entityKey} is not one of your records`)
    return signOwnershipProof(await vault.signer(ref), { entityKey, ...args })
  }

  return {
    app,
    project,
    vault,
    relayers: () => relayers.map((r) => ({ url: r.url, address: r.info?.address, bad: r.bad, info: r.info })),
    relayerAddresses,
    createEntity,
    sendTo,
    /** Your inbox address for this app. Share it; anyone can then `sendTo` it. */
    inboxAddress: () => vault.inboxAddress(),
    myEntities,
    /** How the last `myEntities()` fetched payloads: "all" (the whole app) or "batches" (yours plus cover). */
    lastReadMode: () => lastRead,
    proveOwnership,
    check,
    checkRarity: rarity,
    /** The key a scope's records are owned by, for sharing it on purpose. */
    scopeAddress: (name: string) => vault.addressOf(scopeRef(name)),
  }
}

export type PrivateClient = Awaited<ReturnType<typeof createPrivateClient>>
