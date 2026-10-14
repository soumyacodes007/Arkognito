// The privacy upgrades on Tiramisu: cover records (B5), inbox records (send to user), passkey roots
// and download-all reads. One local relayer with tokens on and COVER_MIN_BATCH=5.
//
//   npx tsx --conditions=arkognito-source tests/privacy-upgrades.ts
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { eq } from "@arkiv-network/sdk/query"
import {
  ARKOGNITO_PROJECT,
  KeyVault,
  TokenWallet,
  createPrivateClient,
  fetchBatches,
  parseEnvelope,
  sealEnvelope,
  toWire,
  verifyOwnershipProof,
  verifyRecord,
  type ArkivReader,
  type SubmitRequest,
} from "arkognito"
import type { Hex } from "viem"
import { WriteQueue, arkivClients } from "../packages/relayer/src/arkiv"
import { Issuer, seedFromEnv } from "../packages/relayer/src/issuer"
import { createTokenGate } from "../packages/relayer/src/tokengate"
import { check, done, localRelayer, makeUser, publicClient, runId } from "./helpers"

const app = `arkognito-pu-${runId}`
const project = `arkognito-pu-${runId}`
const enc = new TextEncoder()
const lower = (s: string) => s.toLowerCase()
console.log(`run ${runId}, project ${project}`)

const rpc = process.env.ARKIV_RPC_URL!
const accessKey = process.env.ARKIV_ACCESS_KEY
const log = (m: string) => console.log(`  ${m}`)
const issuer = new Issuer(arkivClients(rpc, accessKey, process.env.ISSUER_WALLET_PRIVATE_KEY as Hex), new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), { quotaPerDay: 50, log })
const port = 8841
const gate = createTokenGate(arkivClients(rpc, accessKey, process.env.RELAYER_1_PRIVATE_KEY as Hex), issuer.address, log, issuer.routes.bind(issuer))
const relay = await localRelayer("cover", "RELAYER_1_PRIVATE_KEY", port, {
  REQUIRE_TOKENS: "on",
  ISSUER_WALLET_ADDRESS: issuer.address,
  ISSUER_URL: `http://localhost:${port}`,
  COVER_MIN_BATCH: "5",
}, gate)

/** Records every read, to see what the RPC provider learns. */
function recordingReader() {
  const calls: string[] = []
  const reader = new Proxy(publicClient, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === "query") return (q: unknown, o: unknown) => (calls.push(String(q)), (v as Function).call(target, q, o))
      return v
    },
  }) as unknown as ArkivReader
  return { reader, calls }
}

/** A software passkey with the PRF extension (see packages/sdk/test/privacy.test.ts). */
function fakeAuthenticator() {
  const creds = new Map<string, Uint8Array>()
  const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("hex")
  const prf = (secret: Uint8Array, salt: Uint8Array) => hmac(sha256, secret, sha256(new Uint8Array([...enc.encode("WebAuthn PRF"), 0, ...salt])))
  const cred = (rawId: Uint8Array, first?: Uint8Array) => ({
    rawId: rawId.buffer,
    getClientExtensionResults: () => ({ prf: first ? { results: { first: first.slice().buffer } } : { enabled: true } }),
  })
  return {
    async create() {
      const rawId = crypto.getRandomValues(new Uint8Array(16))
      creds.set(hex(rawId), crypto.getRandomValues(new Uint8Array(32)))
      return cred(rawId) as unknown as Credential
    },
    async get(o: CredentialRequestOptions) {
      const id = hex(o.publicKey!.allowCredentials![0].id as Uint8Array)
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first
      return cred(new Uint8Array(Buffer.from(id, "hex")), prf(creds.get(id)!, salt)) as unknown as Credential
    },
  }
}

/**
 * A private client with tokens ready. Tokens are fetched up front without the 60 s minimum age, so
 * the test does not wait (that rule has its own test).
 */
async function clientFor(vault: KeyVault, extra: { reader?: ArkivReader; fetchAllUnder?: number } = {}) {
  const reader = extra.reader ?? (publicClient as unknown as ArkivReader)
  const tw = new TokenWallet({ identity: vault, reader, issuer: issuer.address, issuerUrl: relay.url, minAgeMs: 0 })
  await tw.acquire(app, 4)
  return createPrivateClient({
    app,
    project,
    relayers: [relay.url],
    vault,
    publicClient: reader,
    isolateKeys: false,
    delayMs: [0, 0],
    rarityK: 0,
    inbox: true,
    fetchAllUnder: extra.fetchAllUnder,
    tokens: tw.source(),
  })
}

const relayerAddress = ((await (await fetch(`${relay.url}/v1/info`)).json()) as { address: string }).address
const alice = await makeUser(app)
const bob = await makeUser(app)
const a = await clientFor(alice.vault)
const b = await clientFor(bob.vault)

// ---- B5: cover records ----------------------------------------------------------------------
{
  const res = await a.createEntity({ payload: enc.encode(JSON.stringify({ note: "synthetic report" })), contentType: "application/json", attributes: { type: "report" }, expires: 3600, encrypt: true })
  check("B5: a lone encrypted record lands in a batch of 5, 4 of them cover", res.batchSize === 5 && res.cover === 4, `batch ${res.batchSize}, cover ${res.cover}`)
  const head = await publicClient.getEntity(res.entityKey)
  const batch = await fetchBatches(publicClient as unknown as ArkivReader, project, [{ block: head.createdAt!, creator: head.creator }])
  const sizes = new Set(batch.map((r) => r.payload.length))
  const owners = new Set(batch.map((r) => lower(r.owner)))
  const verified = await Promise.all(batch.map((r) => verifyRecord(r, { app })))
  check("B5: on chain, 5 records in that transaction, one size, five owners", batch.length === 5 && sizes.size === 1 && owners.size === 5, `${batch.length} records, sizes ${[...sizes]}, ${owners.size} owners`)
  check("B5: every record in it verifies like an honest record (signed by its own owner)", verified.every((v) => v.ok))
  const shape = (r: (typeof batch)[number]) => JSON.stringify(Object.entries(r.attributes ?? {}).filter(([k]) => k !== "vtag").sort())
  check("B5: they carry the same attributes apart from the tag", new Set(batch.map(shape)).size === 1)
  check("B5: envelopes all say encrypted, same app and expiry", batch.every((r) => { const e = parseEnvelope(r.payload); return e.enc === 1 && e.app === app && e.exp === 3600 }))
  const markers = await publicClient
    .select({ key: true, createdAt: true })
    .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.spent"), eq("app", app))
    .createdBy(head.creator)
    .limit(50)
    .fetch()
  const same = markers.entities.filter((m) => m.createdAt === head.createdAt)
  check("B5: and 5 spent-token markers in the same block, so markers do not count the real records", same.length === 5, `${same.length} markers`)
  const mine = await a.myEntities()
  check("B5: myEntities() returns only the real record; cover tags open for nobody", mine.length === 1 && mine[0].entityKey === res.entityKey && mine[0].toJson().note === "synthetic report", `${mine.length} found`)
}

// ---- no cover for plaintext ------------------------------------------------------------------
{
  const res = await b.createEntity({ payload: enc.encode("plain note"), contentType: "text/plain", attributes: { type: "note" }, expires: 3600 })
  check("B5: a plaintext record gets no cover (random bytes cannot pass for it)", res.batchSize === 1 && !res.cover, `batch ${res.batchSize}, cover ${res.cover ?? 0}`)
}

// ---- inbox: send to user ---------------------------------------------------------------------
{
  const inbox = await a.inboxAddress()
  const sent = await b.sendTo(inbox, { payload: enc.encode(JSON.stringify({ msg: "your stock report is due tomorrow" })), contentType: "application/json", attributes: { type: "reminder" }, expires: 3600 })
  check("inbox: Bob writes a record for Alice through the relayer", !!sent.entityKey, `batch ${sent.batchSize}, cover ${sent.cover ?? 0}`)
  const mine = await a.myEntities()
  const got = mine.find((r) => r.entityKey === sent.entityKey)
  check("inbox: Alice finds it with myEntities() and reads it", got?.ref.kind === "inbox" && got.toJson().msg === "your stock report is due tomorrow")
  check("inbox: Alice controls its owner", !!got && lower(got.owner) === lower(sent.owner))
  const bobs = await b.myEntities()
  check("inbox: it is not in Bob's records, and Bob cannot read it", !bobs.some((r) => r.entityKey === sent.entityKey))
  const proof = await a.proveOwnership(sent.entityKey, { challenge: `c-${runId}`, verifier: "desk" })
  const ok = await verifyOwnershipProof(proof, { challenge: `c-${runId}`, verifier: "desk", client: publicClient as never })
  check("inbox: Alice proves ownership against the chain", ok.ok, ok.ok ? "" : ok.reason)
  const owned = await publicClient.select({ key: true }).where(eq("project", project)).ownedBy(alice.wallet.account.address).fetch()
  check("inbox: an owner query on Alice's wallet still finds nothing", owned.entities.length === 0)
  const e = await publicClient.getEntity(sent.entityKey)
  check("inbox: the record is created by the relayer, not by Bob", lower(e.creator) === lower(relayerAddress) && lower(e.creator) !== lower(bob.wallet.account.address))
}

// ---- relayer checks for the inbox flag ---------------------------------------------------------
{
  const key = await alice.vault.newRecord()
  const signer = await alice.vault.signer(key.ref)
  const attrs = { project, type: "x", vtag: key.tag }
  const sealed = await sealEnvelope({ signer, app, payload: enc.encode("x"), contentType: "text/plain", attributes: attrs, expSeconds: 3600 })
  const body: SubmitRequest = { app, owner: key.address, envelope: sealed.text, attributes: toWire(attrs), expSeconds: 3600, inbox: true }
  const r = await fetch(`${relay.url}/v1/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  check("relayer: an owner-signed record cannot claim to be an inbox record", r.status === 400, `${r.status} ${await r.text()}`)
}

// ---- passkey root ------------------------------------------------------------------------------
{
  const auth = fakeAuthenticator()
  const created = await KeyVault.createPasskey(app, { credentials: auth })
  const c1 = await clientFor(created.vault)
  const res = await c1.createEntity({ payload: enc.encode("written with a passkey"), contentType: "text/plain", attributes: { type: "note" }, expires: 3600, encrypt: true })
  // A new session: sign in with the passkey alone.
  const again = await createPrivateClient({ app, project, relayers: [relay.url], passkey: { credentials: auth, credentialId: created.credentialId }, publicClient: publicClient as unknown as ArkivReader, isolateKeys: false, tokens: { take: async () => undefined } })
  const mine = await again.myEntities()
  check("passkey: a user with no wallet writes, signs in again and finds the record", mine.some((r) => r.entityKey === res.entityKey && r.toText() === "written with a passkey"))
  const restored = await createPrivateClient({ app, project, relayers: [relay.url], vault: KeyVault.fromRecoveryCode(created.recoveryCode, app), publicClient: publicClient as unknown as ArkivReader, isolateKeys: false, tokens: { take: async () => undefined } })
  check("passkey: the recovery code alone gets the record back", (await restored.myEntities()).some((r) => r.entityKey === res.entityKey))
}

// ---- download-all reads ---------------------------------------------------------------------------
{
  const small = recordingReader()
  const c = await createPrivateClient({ app, project, relayers: [relay.url], vault: alice.vault, publicClient: small.reader, isolateKeys: false, inbox: true, tokens: { take: async () => undefined } })
  const mine = await c.myEntities()
  check("reads: a small app is downloaded whole", c.lastReadMode() === "all" && mine.length >= 2, `${c.lastReadMode()}, ${mine.length} records`)
  check("reads: no query names a block or creator, so nothing points at Alice's batches", small.calls.length > 0 && small.calls.every((q) => !q.includes("$createdAt") && !q.includes("$creator")), `${small.calls.length} queries`)
  const big = recordingReader()
  const c2 = await createPrivateClient({ app, project, relayers: [relay.url], vault: alice.vault, publicClient: big.reader, isolateKeys: false, inbox: true, fetchAllUnder: 0, tokens: { take: async () => undefined } })
  const mine2 = await c2.myEntities()
  check("reads: above the threshold it falls back to batches plus cover, same result", c2.lastReadMode() === "batches" && mine2.length === mine.length && big.calls.some((q) => q.includes("$createdAt")))
}

await relay.close()
done()
process.exit(process.exitCode ?? 0)
