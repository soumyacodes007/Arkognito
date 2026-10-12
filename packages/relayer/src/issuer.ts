// Token issuer (Phase 4). Sees the main wallet and how many tokens it took; never sees a token.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { i32 } from "@arkiv-network/sdk/attr"
import {
  BLOCK_TIME_SECONDS,
  ARKOGNITO_PROJECT,
  epochOf,
  fetchIssuerKey,
  fromBase64,
  issuanceMessage,
  toBase64,
  tokenSuite,
  type IssueRequest,
} from "arkognito"
import { type Address, type Hex, hexToBytes, isAddress, recoverMessageAddress } from "viem"
import type { ArkivClients, WriteQueue } from "./arkiv"
import { deriveRsaKeyPair } from "./rsa"

const DAY_MS = 86_400_000
type DayKey = Awaited<ReturnType<typeof deriveRsaKeyPair>>

export class Issuer {
  #keys = new Map<string, Promise<DayKey>>()
  #published = new Map<string, Promise<Hex>>()
  /**
   * Issued count per (wallet, app, day), keyed by an HMAC under the issuer seed so the quota file
   * names no wallet. Never written to Arkiv. Persisted to `quotaFile` when set, so a restart does not
   * hand everyone a fresh quota.
   */
  #issued = new Map<string, { n: number; epoch: number }>()
  /** For the Phase 4 unlinkability test only: what an issuer could log. Off unless keepTestLog. */
  readonly testLog: { wallet: Address; blinded: string; blindSig: string; at: number }[] = []

  constructor(
    private arkiv: ArkivClients,
    private writer: WriteQueue,
    private seed: Uint8Array,
    private opts: {
      quotaPerDay: number
      log: (m: string) => void
      keepTestLog?: boolean
      quotaFile?: string
      /**
       * Sybil resistance (T5): sha256 hashes (hex) of one-time attestation codes, such as codes handed
       * out in person at a Kendra counter. When set, issuance needs a valid code, the quota counts per
       * code instead of per wallet, and a code is good for one day only. Wallets are free; visits are not.
       */
      attestationCodes?: Set<string>
    },
  ) {
    this.#loadQuota()
  }

  #quotaKey(wallet: string, app: string, epoch: number): string {
    return Buffer.from(hmac(sha256, this.seed, new TextEncoder().encode(`quota|${wallet.toLowerCase()}|${app}|${epoch}`))).toString("hex")
  }

  #loadQuota() {
    const f = this.opts.quotaFile
    if (!f || !existsSync(f)) return
    const today = epochOf()
    try {
      const saved = JSON.parse(readFileSync(f, "utf8")) as Record<string, { n: number; epoch: number }>
      for (const [k, v] of Object.entries(saved)) if (k.startsWith("code:") || v.epoch >= today - 1) this.#issued.set(k, v)
      this.opts.log(`loaded ${this.#issued.size} quota entries from ${f}`)
    } catch (e) {
      this.opts.log(`could not read quota file ${f}: ${(e as Error).message}`)
    }
  }

  #saveQuota() {
    const f = this.opts.quotaFile
    if (!f) return
    const today = epochOf()
    // Used attestation codes stay forever (a code is good for one day only); quotas expire.
    for (const [k, v] of this.#issued) if (!k.startsWith("code:") && v.epoch < today - 1) this.#issued.delete(k)
    writeFileSync(`${f}.tmp`, JSON.stringify(Object.fromEntries(this.#issued)))
    renameSync(`${f}.tmp`, f)
  }

  get address(): Address {
    return this.arkiv.address
  }

  dayKey(app: string, epoch: number): Promise<DayKey> {
    const id = `${app}|${epoch}`
    let k = this.#keys.get(id)
    if (!k) {
      k = deriveRsaKeyPair(this.seed, `${app}/${epoch}`)
      this.#keys.set(id, k)
    }
    return k
  }

  /** Makes sure today's key is on Arkiv, published once. Returns the entity key. */
  ensurePublished(app: string, epoch: number): Promise<Hex> {
    const id = `${app}|${epoch}`
    let p = this.#published.get(id)
    if (!p) {
      p = this.#publish(app, epoch)
      this.#published.set(id, p)
      p.catch(() => this.#published.delete(id))
    }
    return p
  }

  async #publish(app: string, epoch: number): Promise<Hex> {
    const key = await this.dayKey(app, epoch)
    return this.writer.run(async () => {
      const existing = await fetchIssuerKey(this.arkiv.publicClient, this.arkiv.address, app, epoch)
      if (existing) {
        if (existing.spki !== key.spki) throw new Error(`a different key is already published for ${app} day ${epoch}`)
        return existing.entityKey
      }
      // Lives until the end of the day plus two days, so late verifiers can still check it.
      const seconds = ((epoch + 3) * DAY_MS - Date.now()) / 1000
      const { entityKey } = await this.arkiv.walletClient.createEntity({
        payload: jsonToPayload({ spki: key.spki, scheme: "RSABSSA-SHA384-PSS-Randomized" }),
        contentType: "application/json",
        attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.issuerKey", app, epoch: i32(epoch) },
        expires: ExpirationTime.fromBlocks(Math.ceil(seconds / BLOCK_TIME_SECONDS)),
      })
      this.opts.log(`published issuer key for ${app} day ${epoch}: ${entityKey}`)
      return entityKey
    })
  }

  async issue(req: IssueRequest & { ts: number }) {
    const epoch = epochOf()
    if (req.epoch !== epoch) throw new Error(`tokens are issued for today only (day ${epoch})`)
    if (!isAddress(req.wallet)) throw new Error("wallet must be an address")
    if (!Array.isArray(req.blinded) || req.blinded.length === 0 || req.blinded.length > 20) throw new Error("ask for 1 to 20 tokens")
    if (Math.abs(Date.now() - Number(req.ts)) > 5 * 60_000) throw new Error("request timestamp is stale")
    const signer = await recoverMessageAddress({ message: issuanceMessage(req, Number(req.ts)), signature: req.walletSignature })
    if (signer.toLowerCase() !== req.wallet.toLowerCase()) throw new Error("wallet signature does not match")
    let subject: string = req.wallet
    if (this.opts.attestationCodes) {
      const code = typeof req.attestation === "string" ? req.attestation.trim() : ""
      const h = Buffer.from(sha256(new TextEncoder().encode(code))).toString("hex")
      if (!code || !this.opts.attestationCodes.has(h)) throw new Error("a valid attestation code is required")
      const usedKey = `code:${this.#quotaKey(h, "", 0)}`
      const firstDay = this.#issued.get(usedKey)?.epoch
      if (firstDay !== undefined && firstDay !== epoch) throw new Error("this attestation code was already used")
      this.#issued.set(usedKey, { n: 0, epoch })
      subject = `code:${h}`
    }
    const quotaKey = this.#quotaKey(subject, req.app, epoch)
    const used = this.#issued.get(quotaKey)?.n ?? 0
    if (used + req.blinded.length > this.opts.quotaPerDay) {
      throw new Error(`daily quota is ${this.opts.quotaPerDay} tokens; ${this.opts.quotaPerDay - used} left`)
    }
    // Reserve before any await, so two concurrent requests from one wallet cannot both pass the check.
    this.#issued.set(quotaKey, { n: used + req.blinded.length, epoch })
    try {
      await this.ensurePublished(req.app, epoch)
      const key = await this.dayKey(req.app, epoch)
      const suite = tokenSuite()
      const blindSignatures: string[] = []
      for (const b of req.blinded) {
        const sig = toBase64(await suite.blindSign(key.privateKey, fromBase64(b)))
        blindSignatures.push(sig)
        if (this.opts.keepTestLog) this.testLog.push({ wallet: req.wallet, blinded: b, blindSig: sig, at: Date.now() })
      }
      this.#saveQuota()
      return { blindSignatures, remaining: this.opts.quotaPerDay - used - req.blinded.length }
    } catch (e) {
      const now = this.#issued.get(quotaKey)?.n ?? 0
      this.#issued.set(quotaKey, { n: Math.max(0, now - req.blinded.length), epoch })
      throw e
    }
  }

  /** HTTP routes, mounted on the relayer's server. */
  async routes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" })
      res.end(JSON.stringify(body))
    }
    if (req.method === "GET" && url.pathname === "/v1/issuer/key") {
      const app = url.searchParams.get("app") ?? ""
      const epoch = Number(url.searchParams.get("epoch") ?? epochOf())
      if (!app || epoch !== epochOf()) return json(400, { error: "app is required and epoch must be today" }), true
      try {
        const entityKey = await this.ensurePublished(app, epoch)
        return json(200, { issuer: this.address, app, epoch, entityKey }), true
      } catch (e) {
        return json(500, { error: (e as Error).message }), true
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/tokens/issue") {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        return json(200, await this.issue(body)), true
      } catch (e) {
        return json(403, { error: (e as Error).message }), true
      }
    }
    return false
  }
}

export function seedFromEnv(hex: string | undefined): Uint8Array {
  if (!hex || !/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("ISSUER_RSA_SEED must be 32 bytes of hex (0x...)")
  return hexToBytes(hex as Hex)
}
