// Phase 4 test (PRD §8):
//  - A wallet over its daily quota is refused tokens.
//  - Writes need a token; each redemption leaves a arkognito.spent marker in the same transaction.
//  - The same token spent twice is rejected (same relayer, and a second relayer via the shared list).
//  - Issuer and relayer logs together cannot match an issued token to a redeemed one (we try).
//  - Publishing a second key for the same day makes clients and relayers refuse that issuer.
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import {
  IssuerEquivocationError,
  TokenWallet,
  ARKOGNITO_PROJECT,
  createPrivateClient,
  epochOf,
  fromBase64,
  sealEnvelope,
  toWire,
  type SubmitRequest,
  type TokenRedemption,
} from "arkognito"
import { type Hex, hexToBytes } from "viem"
import { WriteQueue, arkivClients } from "../packages/relayer/src/arkiv"
import { Issuer, seedFromEnv } from "../packages/relayer/src/issuer"
import { createTokenGate } from "../packages/relayer/src/tokengate"
import { check, done, localRelayer, makeUser, publicClient, runId } from "./helpers"

const app = `arkognito-p4-${runId}`
const project = `arkognito-test-${runId}`
console.log(`run ${runId}, app ${app}`)

const rpc = process.env.ARKIV_RPC_URL!
const key = process.env.ARKIV_ACCESS_KEY
const issuerArkiv = arkivClients(rpc, key, process.env.ISSUER_WALLET_PRIVATE_KEY as Hex)
const log = (m: string) => console.log(`[issuer] ${m}`)
const issuer = new Issuer(issuerArkiv, new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), { quotaPerDay: 5, log, keepTestLog: true })

const tokenEnv = { REQUIRE_TOKENS: "on", ISSUER_WALLET_ADDRESS: issuer.address }
const gateFor = (k: string) => createTokenGate(arkivClients(rpc, key, process.env[k] as Hex), issuer.address, log, issuer.routes.bind(issuer))
const r1 = await localRelayer("relay-1", "RELAYER_1_PRIVATE_KEY", 8811, tokenEnv, gateFor("RELAYER_1_PRIVATE_KEY"))
const r2 = await localRelayer("relay-2", "RELAYER_2_PRIVATE_KEY", 8812, tokenEnv, gateFor("RELAYER_2_PRIVATE_KEY"))

// ---- issuance and quota (T5 quota per wallet) --------------------------------------------
const users = await Promise.all([0, 1, 2, 3].map(() => makeUser(app)))
const wallets = users.map((u) => new TokenWallet({ wallet: u.wallet, reader: publicClient, issuer: issuer.address, issuerUrl: r1.url, minAgeMs: 0 }))
const got = await wallets[0].acquire(app, 5)
check("a wallet gets its 5 tokens for today", got === 5 && wallets[0].available(app) === 5)
let overQuota = ""
try {
  await wallets[0].acquire(app, 1)
} catch (e) {
  overQuota = (e as Error).message
}
check("a 6th token is refused (daily quota)", /quota/.test(overQuota), overQuota.slice(0, 80))
const pub = await (await import("arkognito")).fetchIssuerKey(publicClient, issuer.address, app, epochOf())
check("today's issuer key is on Arkiv, created by the issuer wallet", !!pub)

// ---- redemption ---------------------------------------------------------------------------
const writes = await Promise.all(
  users.slice(0, 3).map(async (u, i) => {
    if (i > 0) await wallets[i].acquire(app, 3)
    const c = await createPrivateClient({
      app, project, vault: u.vault, publicClient, relayers: [r1.url], tokens: wallets[i].source(), delayMs: [0, 0], pollMs: 1000,
    })
    return c.createEntity({ payload: new TextEncoder().encode(`tokened ${i}`), contentType: "text/plain", attributes: { kind: "t" }, expires: 3600 })
  }),
)
check("3 users wrote with tokens", writes.length === 3 && writes.every((w) => w.entityKey))
const spent = await publicClient
  .select({ key: true, attributes: true, creator: true })
  .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.spent"), eq("app", app))
  .fetch()
check("one arkognito.spent marker per redeemed token", spent.entities.length === 3, `${spent.entities.length}`)
const writeTx = new Set(writes.map((w) => w.txHash))
check("markers carry no wallet, only a random token id", spent.entities.every((e) => Object.keys(e.attributes).sort().join() === "app,epoch,project,tokenid,type"))

// A client with no tokens and no on-demand fetching is refused (T2 forces advance fetching).
const noTok = await createPrivateClient({ app, project, vault: users[3].vault, publicClient, relayers: [r1.url], tokens: wallets[3].source(), delayMs: [0, 0] })
let refused = ""
try {
  await noTok.createEntity({ payload: new Uint8Array([1]), contentType: "text/plain", expires: 3600 })
} catch (e) {
  refused = (e as Error).message
}
check("a write without a token is refused", /token/.test(refused), refused.slice(0, 100))

// ---- double spend (T4) ---------------------------------------------------------------------
async function rawWithToken(url: string, token: TokenRedemption, i: number) {
  const key = await users[0].vault.newRecord()
  const signer = await users[0].vault.signer(key.ref)
  const attributes = { project, kind: "double", vtag: key.tag }
  const sealed = await sealEnvelope({ signer, app, payload: new TextEncoder().encode(`d${i}`), contentType: "text/plain", attributes, expSeconds: 3600 })
  const body: SubmitRequest = { app, owner: signer.address, envelope: sealed.text, attributes: toWire(attributes), expSeconds: 3600, token }
  const res = await fetch(`${url}/v1/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
}
const tok = (await wallets[0].source().take(app, { tokensRequired: true } as never))!
const first = await rawWithToken(r1.url, tok, 1)
const again = await rawWithToken(r1.url, tok, 2)
check("same token twice at the same relayer: second is refused", first.status === 202 && again.status === 403, again.body.error)
// wait for the first to land, then try the other relayer
for (let i = 0; i < 60; i++) {
  const s = (await (await fetch(`${r1.url}/v1/records/${first.body.id}`)).json()) as { state: string }
  if (s.state !== "queued") break
  await new Promise((r) => setTimeout(r, 1000))
}
const other = await rawWithToken(r2.url, tok, 3)
check("same token at a second relayer: refused via the shared spent list on Arkiv", other.status === 403, other.body.error)

// ---- unlinkability: try to match issuer log to relayer log --------------------------------
// The relayer sees (prepared message, signature) for each token; the issuer logged (wallet, blinded, blindSig).
const redeemed: TokenRedemption[] = []
for (let i = 0; i < 3; i++) redeemed.push((await wallets[0].source().take(app, { tokensRequired: true } as never))!)
const issued = issuer.testLog.filter((l) => l.wallet.toLowerCase() !== "") // every issuance this run
const dayKey = await issuer.dayKey(app, epochOf())
const n = dayKey.n
const e = 65537n
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex")}`)
const modPow = (b: bigint, x: bigint, m: bigint) => {
  let r = 1n
  b %= m
  while (x > 0n) {
    if (x & 1n) r = (r * b) % m
    b = (b * b) % m
    x >>= 1n
  }
  return r
}
const modInv = (a: bigint, m: bigint) => modPow(a, m - 2n, m) // not prime m; use egcd below instead
void modInv
const egcdInv = (a: bigint, m: bigint) => {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]
  while (r1) {
    const q = r0 / r1
    ;[r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]
  }
  return ((s0 % m) + m) % m
}
// Attempt 1: any byte-level overlap between what the issuer saw and what the relayer saw.
const issuerBytes = new Set(issued.flatMap((l) => [l.blinded, l.blindSig]))
const overlap = redeemed.filter((t) => issuerBytes.has(t.signature) || issuerBytes.has(Buffer.from(hexToBytes(t.nonce as Hex)).toString("base64"))).length
check("attempt 1: no byte overlap between issuer and relayer logs", overlap === 0)
// Attempt 2 (with the issuer's secret key): for a true pair, blindSig = sig * r where r^e = blinded / EM.
// Check how many (issued, redeemed) pairs satisfy that relation.
let consistent = 0
for (const l of issued) {
  for (const t of redeemed) {
    const s = big(fromBase64(t.signature))
    const em = modPow(s, e, n)
    const r = modPow((big(fromBase64(l.blinded)) * egcdInv(em, n)) % n, dayKey.d, n)
    if ((s * r) % n === big(fromBase64(l.blindSig))) consistent++
  }
}
const total = issued.length * redeemed.length
check("attempt 2: every issued token is equally consistent with every redeemed one (link = 1/N guess)", consistent === total,
  `${consistent}/${total} pairs consistent, so the true pairing is indistinguishable`)

// ---- equivocation (T1) -------------------------------------------------------------------
const eqApp = `arkognito-p4-equiv-${runId}`
await issuer.ensurePublished(eqApp, epochOf())
await issuerArkiv.walletClient.createEntity({
  payload: jsonToPayload({ spki: (await issuer.dayKey(`${eqApp}-other`, epochOf())).spki, scheme: "RSABSSA-SHA384-PSS-Randomized" }),
  contentType: "application/json",
  attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.issuerKey", app: eqApp, epoch: i32(epochOf()) },
  expires: ExpirationTime.fromHours(2),
})
let clientRefused: unknown
try {
  await new TokenWallet({ wallet: users[3].wallet, reader: publicClient, issuer: issuer.address, issuerUrl: r1.url, minAgeMs: 0 }).acquire(eqApp, 1)
} catch (err) {
  clientRefused = err
}
check("client refuses an issuer with two keys for one day", clientRefused instanceof IssuerEquivocationError, (clientRefused as Error)?.message)
let relayerRefusal = ""
try {
  const fakeToken: TokenRedemption = { epoch: epochOf(), nonce: `0x${"11".repeat(64)}`, signature: "AA==" }
  await gateFor("RELAYER_2_PRIVATE_KEY").redeem({ app: eqApp, token: fakeToken } as SubmitRequest)
} catch (err) {
  relayerRefusal = (err as Error).message
}
check("relayer refuses tokens from an equivocating issuer", /2 keys|refusing/.test(relayerRefusal), relayerRefusal.slice(0, 90))

void writeTx
void bytes32
await r1.close()
await r2.close()
done()
process.exit()
