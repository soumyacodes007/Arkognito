// Blind-token rate limits (PRD §5 "Blind tokens", T1–T9).
//
// Scheme: RSABSSA-SHA384-PSS-Randomized (RFC 9474) via @cloudflare/blindrsa-ts.
// One issuer key per app per UTC day, published on Arkiv as `arkognito.issuerKey` by the issuer's wallet.
// Clients and relayers accept a key only from there, and refuse an issuer that published two keys
// for the same app and day (T1, key-consistency).
import { RSABSSA } from "@cloudflare/blindrsa-ts"
import { eq } from "@arkiv-network/sdk/query"
import { i32 } from "@arkiv-network/sdk/attr"
import { sha256 } from "@noble/hashes/sha2.js"
import { type Address, type Hex, bytesToHex, hexToBytes } from "viem"
import { fromBase64, toBase64 } from "./envelope.ts"
import { ARKOGNITO_PROJECT } from "./constants.ts"
import { type SigningWallet, asSigner } from "./derive.ts"
import type { InfoResponse, IssueRequest, IssueResponse, TokenRedemption } from "./protocol.ts"
import type { ArkivReader } from "./reader.ts"

export const tokenSuite = () => RSABSSA.SHA384.PSS.Randomized()

const DAY = 86_400_000
/** UTC day number. */
export const epochOf = (ms = Date.now()) => Math.floor(ms / DAY)

/** T9: tokens from the previous epoch are accepted for one hour after midnight UTC. */
export function acceptableEpochs(ms = Date.now()): number[] {
  const e = epochOf(ms)
  return ms - e * DAY < 3_600_000 ? [e, e - 1] : [e]
}

export class IssuerEquivocationError extends Error {
  constructor(app: string, epoch: number, count: number) {
    super(`issuer published ${count} keys for ${app} on day ${epoch}; refusing this issuer (T1)`)
  }
}

export async function importIssuerKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(spkiB64), { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"])
}

/** Issuer key for (app, epoch) as published on Arkiv by `issuer`. Throws on equivocation; undefined if none. */
export async function fetchIssuerKey(
  reader: ArkivReader,
  issuer: Address,
  app: string,
  epoch: number,
): Promise<{ key: CryptoKey; spki: string; entityKey: Hex } | undefined> {
  const { entities } = await reader
    .select({ key: true, payload: true })
    .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.issuerKey"), eq("app", app), eq("epoch", i32(epoch)))
    .createdBy(issuer)
    .limit(10)
    .fetch()
  if (entities.length === 0) return undefined
  if (entities.length > 1) throw new IssuerEquivocationError(app, epoch, entities.length)
  const { spki } = entities[0].toJson() as { spki: string }
  return { key: await importIssuerKey(spki), spki, entityKey: entities[0].key }
}

/** The message a wallet signs to ask for tokens. Includes a timestamp so a captured request cannot be replayed later. */
export function issuanceMessage(r: Pick<IssueRequest, "app" | "epoch" | "blinded">, ts: number) {
  const digest = bytesToHex(sha256(new TextEncoder().encode(r.blinded.join(","))))
  return `arkognito tokens v1\napp: ${r.app}\nday: ${r.epoch}\ncount: ${r.blinded.length}\nrequest: ${digest}\nts: ${ts}`
}

/** sha256 of the prepared message: the public id recorded in `arkognito.spent`. Random, so it says nothing about the holder. */
export function tokenId(prepared: Uint8Array): Hex {
  return bytesToHex(sha256(prepared))
}

export type StoredToken = TokenRedemption & { app: string; issuedAt?: number }

/** Where a TokenWallet keeps unspent tokens between page loads (e.g. localStorage). */
export type TokenStore = { load(): StoredToken[]; save(tokens: StoredToken[]): void }

/** Keeps unspent tokens in localStorage, so tokens fetched in one session are spent in a later one (T2). */
export function browserTokenStore(name = "arkognito:tokens"): TokenStore {
  const fallback = memoryStore()
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(name)
        return raw ? (JSON.parse(raw) as StoredToken[]) : fallback.load()
      } catch {
        return fallback.load()
      }
    },
    save(tokens) {
      fallback.save(tokens)
      try {
        globalThis.localStorage?.setItem(name, JSON.stringify(tokens))
      } catch {
        // storage blocked: memory only
      }
    },
  }
}

export const memoryStore = (): TokenStore => {
  let t: StoredToken[] = []
  return { load: () => t, save: (x) => void (t = x) }
}

/**
 * Client side. Fetches the day's tokens in advance, at a random time (T2), and hands out one per
 * write attempt. Issuance needs the main wallet (quota is per wallet); redemption never does.
 */
export class TokenWallet {
  #store: TokenStore
  constructor(
    private opts: {
      wallet: SigningWallet
      reader: ArkivReader
      issuer: Address
      issuerUrl: string
      store?: TokenStore
      /** Allow fetching right before a write when the pool is empty. Off by default (T2). */
      allowOnDemand?: boolean
      /** One-time attestation code, for issuers that require one (T5). */
      attestation?: string
      /**
       * A token is not spent until it is at least this old (T2), so issuance and redemption never sit
       * next to each other in time. The oldest token is always spent first. Default 60 s.
       */
      minAgeMs?: number
      fetch?: typeof fetch
    },
  ) {
    this.#store = opts.store ?? memoryStore()
  }

  available(app: string, ms = Date.now()) {
    const ok = acceptableEpochs(ms)
    return this.#store.load().filter((t) => t.app === app && ok.includes(t.epoch)).length
  }

  /** Gets `count` tokens for today. Prefer `prefetchLater`, which spreads issuance away from use. */
  async acquire(app: string, count: number, attestation?: string): Promise<number> {
    const fetchFn = this.opts.fetch ?? globalThis.fetch.bind(globalThis)
    const epoch = epochOf()
    const published = await fetchIssuerKey(this.opts.reader, this.opts.issuer, app, epoch)
    if (!published) {
      // Ask the issuer to publish today's key, then read it from Arkiv (never trust the HTTP copy).
      await fetchFn(`${this.opts.issuerUrl}/v1/issuer/key?app=${encodeURIComponent(app)}&epoch=${epoch}`)
    }
    const key = published ?? (await fetchIssuerKey(this.opts.reader, this.opts.issuer, app, epoch))
    if (!key) throw new Error(`no issuer key on Arkiv for ${app} day ${epoch}`)

    const suite = tokenSuite()
    const pending = await Promise.all(
      Array.from({ length: count }, async () => {
        const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)))
        const { blindedMsg, inv } = await suite.blind(key.key, prepared)
        return { prepared, blindedMsg, inv }
      }),
    )
    const signer = asSigner(this.opts.wallet)
    const account = signer.account
    const body = { app, epoch, wallet: account.address, blinded: pending.map((p) => toBase64(p.blindedMsg)) }
    const ts = Date.now()
    const walletSignature = await signer.signMessage({ account, message: issuanceMessage(body, ts) })
    const res = await fetchFn(`${this.opts.issuerUrl}/v1/tokens/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, walletSignature, ts, attestation: attestation ?? this.opts.attestation }),
    })
    if (!res.ok) throw new Error(`issuer refused: ${res.status} ${await res.text()}`)
    const { blindSignatures } = (await res.json()) as IssueResponse
    const tokens: StoredToken[] = []
    for (const [i, p] of pending.entries()) {
      const sig = await suite.finalize(key.key, p.prepared, fromBase64(blindSignatures[i]), p.inv)
      if (!(await suite.verify(key.key, sig, p.prepared))) throw new Error("issuer returned an invalid signature")
      tokens.push({ app, epoch, nonce: bytesToHex(p.prepared), signature: toBase64(sig), issuedAt: Date.now() })
    }
    this.#store.save([...this.#store.load(), ...tokens])
    return tokens.length
  }

  /** T2: schedules issuance at a random moment within the next `withinMs`, away from any write. */
  prefetchLater(app: string, count: number, withinMs = 6 * 3_600_000): Promise<number> {
    const delay = Math.random() * withinMs
    return new Promise((resolve, reject) => setTimeout(() => this.acquire(app, count).then(resolve, reject), delay))
  }

  /** TokenSource for createPrivateClient: one token per write attempt, never reused. */
  source() {
    return {
      take: async (app: string, relayer: InfoResponse): Promise<TokenRedemption | undefined> => {
        if (!relayer.tokensRequired) return undefined
        const ok = acceptableEpochs()
        const oldest = (all: StoredToken[]) =>
          all
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => t.app === app && ok.includes(t.epoch))
            .sort((a, b) => (a.t.issuedAt ?? 0) - (b.t.issuedAt ?? 0))[0]
        let pick = oldest(this.#store.load())
        if (!pick && this.opts.allowOnDemand) {
          await this.acquire(app, 1)
          pick = oldest(this.#store.load())
        }
        if (!pick) throw new Error("no rate-limit token left for today; fetch tokens in advance with prefetchLater()")
        const wait = (pick.t.issuedAt ?? 0) + (this.opts.minAgeMs ?? 60_000) - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        // Re-read: another tab may have spent tokens while this one waited.
        const all = this.#store.load()
        const idx = all.findIndex((x) => x.nonce === pick!.t.nonce)
        if (idx < 0) throw new Error("token was spent by another session; retry")
        const [t] = all.splice(idx, 1)
        this.#store.save(all)
        return { epoch: t.epoch, nonce: t.nonce, signature: t.signature }
      },
    }
  }
}

/** Verifies a redeemed token against a published key. Returns its spent-list id. */
export async function verifyToken(key: CryptoKey, t: TokenRedemption): Promise<Hex> {
  const prepared = hexToBytes(t.nonce)
  if (prepared.length !== 64) throw new Error("token message must be 64 bytes (32 randomizer + 32 nonce)")
  const ok = await tokenSuite().verify(key, fromBase64(t.signature), prepared)
  if (!ok) throw new Error("token signature is invalid")
  return tokenId(prepared)
}
