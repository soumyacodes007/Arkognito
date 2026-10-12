// Edge-case sweep, on Tiramisu. Each block names the PRD edge case it covers (docs/edge-cases.md).
import { ExpirationTime } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { ARKOGNITO_PROJECT, createPrivateClient, KeyVault, epochOf, fetchIssuerKey, issuanceMessage, toBase64, tokenSuite, type SubmitRequest } from "arkognito"
import { eq } from "@arkiv-network/sdk/query"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { WriteQueue, arkivClients } from "../packages/relayer/src/arkiv"
import { Issuer, seedFromEnv } from "../packages/relayer/src/issuer"
import { startOhttpRelay } from "../packages/relayer/src/ohttp-relay"
import { check, done, localRelayer, makeUser, publicClient, rawSubmit, runId, sleep } from "./helpers"

const app = "arkognito-edge"
const project = `arkognito-edge-${runId}`
const lower = (s: string) => s.toLowerCase()
console.log(`run ${runId}, project ${project}`)

/** An Arkiv reader that records every read, to check what the RPC provider learns. */
function recordingReader() {
  const log: { method: string; detail: string }[] = []
  const reader = new Proxy(publicClient, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === "getEntity") return (key: string) => (log.push({ method: "getEntity", detail: key }), (v as Function).call(target, key))
      if (prop === "query") return (q: unknown, o: unknown) => (log.push({ method: "query", detail: String(q) }), (v as Function).call(target, q, o))
      if (prop === "select") {
        return (sel: unknown) => {
          const b = (v as Function).call(target, sel)
          const where = b.where.bind(b)
          b.where = (...args: unknown[]) => (log.push({ method: "select", detail: String(args.flat().map(String)) }), where(...args))
          const ownedBy = b.ownedBy.bind(b)
          b.ownedBy = (a: string) => (log.push({ method: "ownedBy", detail: a }), ownedBy(a))
          return b
        }
      }
      return v
    },
  })
  return { reader, log }
}

// ---- 1. reads never name your record or address (D1); devices; encryption (A6); rarity (F3) ----
{
  const relay = await localRelayer("edge-1", "RELAYER_1_PRIVATE_KEY", 8821, { MIN_BATCH: "1", MAX_WAIT_MS: "0" })
  const user = await makeUser(app)
  const { reader, log } = recordingReader()
  const phone = await createPrivateClient({ app, project, vault: user.vault, publicClient: reader as never, relayers: [relay.url], delayMs: [0, 0], pollMs: 1000 })
  const plain = await phone.createEntity({ payload: new TextEncoder().encode("plain note"), contentType: "text/plain", attributes: { kind: "note" }, expires: 3600 })
  const secret = await phone.createEntity({ payload: new TextEncoder().encode("refill: insulin"), contentType: "text/plain", attributes: { kind: "note" }, expires: 3600, encrypt: true })
  const mine = await phone.myEntities()
  const named = log.filter((l) => [plain.entityKey, secret.entityKey, plain.owner, secret.owner].some((x) => lower(l.detail).includes(lower(x))))
  check("D1: no read names your record key or owner address", named.length === 0, `${log.length} reads, ${named.length} naming yours`)
  check("D1: no single-record fetch at all (getEntity)", !log.some((l) => l.method === "getEntity"))
  check("myEntities() finds both records", mine.length === 2)
  check("A6: the encrypted record decrypts for its owner", mine.find((m) => m.key === secret.entityKey)?.toText() === "refill: insulin")
  const raw = await publicClient.getEntity(secret.entityKey)
  check("A6: the encrypted payload is unreadable on chain", !new TextDecoder().decode(raw.payload).includes("insulin"))

  // A second device: same wallet, new vault instance, nothing shared but the wallet.
  const laptopVault = await KeyVault.fromWallet(user.wallet, app)
  const laptop = await createPrivateClient({ app, project, vault: laptopVault, publicClient, relayers: [relay.url], delayMs: [0, 0], pollMs: 1000 })
  check("K8: a second device finds both records with nothing but the wallet", (await laptop.myEntities()).length === 2)
  const fromLaptop = await laptop.createEntity({ payload: new TextEncoder().encode("from laptop"), contentType: "text/plain", attributes: { kind: "note" }, expires: 3600 })
  const owners = new Set([plain.owner, secret.owner, fromLaptop.owner].map(lower))
  check("K7: two devices never pick the same owner", owners.size === 3)
  check("phone sees the laptop's record too", (await phone.myEntities()).length === 3)
  const tags = (await publicClient.select({ attributes: true }).where(eq("project", project)).fetch()).entities.map((e) => String(e.attributes.vtag?.value))
  check("every record carries a tag of the same length", tags.length === 3 && new Set(tags.map((t) => t.length)).size === 1, `${tags[0]?.length} chars`)

  const rare = await phone.createEntity({ payload: new TextEncoder().encode("x"), contentType: "text/plain", attributes: { kind: "note", village: "tiny-hamlet" }, expires: 3600 })
  check("F3: a rare attribute combination is flagged", rare.warnings.some((w) => w.code === "rare-combination"))
  await relay.close()
}

// ---- 2. a relayer that writes and then dies does not cause a duplicate (R4) ----------------
{
  const ghost = await localRelayer("ghost", "RELAYER_2_PRIVATE_KEY", 8822, { MIN_BATCH: "1", MAX_WAIT_MS: "0", ARKOGNITO_EVIL: "ghost" })
  const honest = await localRelayer("honest", "RELAYER_1_PRIVATE_KEY", 8823, { MIN_BATCH: "1", MAX_WAIT_MS: "0" })
  const user = await makeUser(app)
  const c = await createPrivateClient({ app, project, vault: user.vault, publicClient, relayers: [ghost.url, honest.url], delayMs: [0, 0], pollMs: 1000, inclusionTimeoutMs: 20_000 })
  const r = await c.createEntity({ payload: new TextEncoder().encode("once"), contentType: "text/plain", expires: 3600 })
  check("R4: the client noticed its record had landed and did not resend", r.recovered === true && r.relayer === "", JSON.stringify({ recovered: r.recovered, relayer: r.relayer }))
  const { entities } = await publicClient.select({ key: true }).where(eq("project", project)).ownedBy(r.owner).fetch()
  check("R4: exactly one record for that owner", entities.length === 1, `${entities.length}`)
  await ghost.close()
  await honest.close()
}

// ---- 3. minimum anonymity set (B2) ---------------------------------------------------------
{
  const relay = await localRelayer("eager", "RELAYER_1_PRIVATE_KEY", 8824, { MIN_BATCH: "1", MAX_WAIT_MS: "0", MIN_INTERVAL_BLOCKS: "1" })
  const opts = { app, project, publicClient, relayers: [relay.url], delayMs: [0, 0] as [number, number], pollMs: 1000, minAnonymity: 3, maxHoldMs: 20_000 }
  const alone = await createPrivateClient({ ...opts, vault: (await makeUser(app)).vault })
  let refused = ""
  try {
    await alone.createEntity({ payload: new TextEncoder().encode("alone"), contentType: "text/plain", expires: 3600 })
  } catch (e) {
    refused = (e as Error).message
  }
  check("B2: a lone record that asked for 3 is not written in a batch of 1", /no batch of 3/.test(refused), refused.slice(0, 120))
  const three = await Promise.all([0, 1, 2].map(async () => createPrivateClient({ ...opts, vault: (await makeUser(app)).vault })))
  const res = await Promise.all(three.map((c) => c.createEntity({ payload: new TextEncoder().encode("together"), contentType: "text/plain", expires: 3600 })))
  check("B2: three records that asked for 3 land together", res.every((r) => (r.batchSize ?? 0) >= 3), res.map((r) => r.batchSize).join(","))
  await relay.close()
}

// ---- 4. Oblivious HTTP: the relayer never sees the client (R7) -------------------------------
{
  const relayer = await localRelayer("ohttp-relayer", "RELAYER_1_PRIVATE_KEY", 8825, { MIN_BATCH: "1", MAX_WAIT_MS: "0", HEARTBEAT: "on" })
  const relay = startOhttpRelay({ port: 8826, rpcUrl: process.env.ARKIV_RPC_URL, accessKey: process.env.ARKIV_ACCESS_KEY, allowLocal: true })
  await relay.listen()
  const contacted: string[] = []
  const spyFetch = ((url: string, init?: RequestInit) => (contacted.push(new URL(url).origin), fetch(url, init))) as typeof fetch
  const user = await makeUser(app)
  const c = await createPrivateClient({
    app, project, vault: user.vault, publicClient, relayers: [relayer.url], ohttpRelay: "http://localhost:8826", fetch: spyFetch, delayMs: [0, 0], pollMs: 1000,
  })
  const r = await c.createEntity({ payload: new TextEncoder().encode("via ohttp"), contentType: "text/plain", expires: 3600 })
  check("R7: a record written through the OHTTP relay lands and verifies", !!r.entityKey && r.relayer === relayer.url)
  check("R7: the client never contacted the relayer directly", !contacted.includes(new URL(relayer.url).origin), [...new Set(contacted)].join(", "))
  check("R7: every relayer call went through the relay", contacted.length > 0 && contacted.every((o) => o === "http://localhost:8826"))
  const forged = await fetch("http://localhost:8826/ohttp", { method: "POST", headers: { "x-arkognito-target": "http://example.com" }, body: "x" })
  check("R7: the relay refuses targets that are not live relayers (no open proxy)", forged.status === 403)
  await relay.close()
  await relayer.close()
}

// ---- 4b. heartbeat squatting and SSRF through the relay (N24, N25) --------------------------
{
  const relayer = await localRelayer("real", "RELAYER_1_PRIVATE_KEY", 8831, { MIN_BATCH: "1", MAX_WAIT_MS: "0", HEARTBEAT: "on" })
  const attacker = arkivClients(process.env.ARKIV_RPC_URL!, process.env.ARKIV_ACCESS_KEY, process.env.RELAYER_2_PRIVATE_KEY as Hex)
  const fakeHeartbeat = (url: string) => ({
    payload: new Uint8Array(),
    contentType: "application/json",
    attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.relayer", url, version: "arkognito-relayer/1", minbatch: i32(1), tokens: false, ohttpkey: bytes32(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))) },
    expires: ExpirationTime.fromMinutes(10),
  })
  await attacker.walletClient.executeBatch({ creates: [fakeHeartbeat(relayer.url), fakeHeartbeat("http://169.254.169.254")] })
  const relay = startOhttpRelay({ port: 8832, rpcUrl: process.env.ARKIV_RPC_URL, accessKey: process.env.ARKIV_ACCESS_KEY, allowLocal: true })
  await relay.listen()
  const user = await makeUser(app)
  const c = await createPrivateClient({ app, project, vault: user.vault, publicClient, relayers: [relayer.url], ohttpRelay: "http://localhost:8832", delayMs: [0, 0], pollMs: 1000 })
  const r = await c.createEntity({ payload: new TextEncoder().encode("despite squatters"), contentType: "text/plain", expires: 3600 })
  check("N24: a squatting heartbeat with a fake key for the same URL does not block or redirect the client", !!r.entityKey && r.relayer === relayer.url)
  const ssrf = await fetch("http://localhost:8832/ohttp", { method: "POST", headers: { "x-arkognito-target": "http://169.254.169.254" }, body: "x" })
  check("N25: the relay will not forward to a target announced only by a heartbeat it cannot verify", ssrf.status === 403)
  await relay.close()
  const strict = startOhttpRelay({ port: 8833, rpcUrl: process.env.ARKIV_RPC_URL, accessKey: process.env.ARKIV_ACCESS_KEY })
  await strict.listen()
  const local = await fetch("http://localhost:8833/ohttp", { method: "POST", headers: { "x-arkognito-target": relayer.url }, body: "x" })
  check("N25: in production mode the relay refuses http and loopback targets, even live ones", local.status === 403)
  await strict.close()
  await relayer.close()
}

// ---- 5. abuse limits with tokens off (rate limit, queue cap) --------------------------------
{
  const relay = await localRelayer("limits", "RELAYER_2_PRIVATE_KEY", 8827, { MIN_BATCH: "1000", MAX_WAIT_MS: "600000", RATE_LIMIT_PER_MIN: "3", MAX_QUEUE: "2" })
  const u = await makeUser(app)
  const statuses: number[] = []
  for (let i = 0; i < 4; i++) {
    try {
      await rawSubmit(relay.url, u.vault, i, app, { project, kind: "spam" })
      statuses.push(202)
    } catch (e) {
      statuses.push(Number(String((e as Error).message).match(/submit (\d+)/)?.[1]))
    }
  }
  check("queue cap: a full queue answers 503", statuses[2] === 503, statuses.join(","))
  check("rate limit: the 4th request in a minute from one address answers 429", statuses[3] === 429, statuses.join(","))
  await relay.close()
}

// ---- 6. attestation codes at issuance (T5) ---------------------------------------------------
{
  const issuerArkiv = arkivClients(process.env.ARKIV_RPC_URL!, process.env.ARKIV_ACCESS_KEY, process.env.ISSUER_WALLET_PRIVATE_KEY as Hex)
  const codeHash = (c: string) => Buffer.from(sha256(new TextEncoder().encode(c))).toString("hex")
  const issuer = new Issuer(issuerArkiv, new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), {
    quotaPerDay: 3,
    log: () => undefined,
    attestationCodes: new Set([codeHash(`KENDRA-${runId}`)]),
  })
  const tokApp = `arkognito-attest-${runId}`
  const ask = async (attestation: string | undefined, n: number) => {
    const w = privateKeyToAccount(generatePrivateKey())
    const epoch = epochOf()
    await issuer.ensurePublished(tokApp, epoch)
    const pub = (await fetchIssuerKey(publicClient, issuer.address, tokApp, epoch))!
    const suite = tokenSuite()
    const blinded = await Promise.all(Array.from({ length: n }, async () => toBase64((await suite.blind(pub.key, suite.prepare(crypto.getRandomValues(new Uint8Array(32))))).blindedMsg)))
    const ts = Date.now()
    const walletSignature = await w.signMessage({ message: issuanceMessage({ app: tokApp, epoch, blinded }, ts) })
    return issuer.issue({ app: tokApp, epoch, wallet: w.address, walletSignature, blinded, ts, attestation })
  }
  const err = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message)
  check("T5: no code, no tokens", /attestation code is required/.test(await err(ask(undefined, 1))))
  check("T5: a wrong code, no tokens", /attestation code is required/.test(await err(ask("GUESS-1234", 1))))
  check("T5: a valid code gets tokens", (await ask(`KENDRA-${runId}`, 2)).blindSignatures.length === 2)
  check("T5: a second fresh wallet with the same code shares its quota (3), it does not get a new one",
    /1 left/.test(await err(ask(`KENDRA-${runId}`, 2))))
}

done()
process.exit()
