// Opt-in, synthetic Tiramisu integration. Only the previously funded throwaway spike key signs.
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, keccak256, parseEther, parseTransaction, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { KeyVault, createPrivateClient, envelopeDigest, padEnvelope, sealEnvelope, toBase64, toWire } from "arkognito"
import { createSemaphoreGroup, addSemaphoreMembers, createSemaphoreReader, membershipAttributes, membershipMessage, semaphoreScope, type SemaphoreRules, type Membership } from "arkognito/semaphore"
import { WriteQueue, type ArkivClients } from "../packages/relayer/src/arkiv"
import { loadConfig } from "../packages/relayer/src/config"
import { startRelayer } from "../packages/relayer/src/server"
import { chromium } from "playwright"
import { createServer as createViteServer } from "vite"
import { createHash } from "node:crypto"

const root = resolve(import.meta.dirname, "..")
const runId = Date.now().toString()
const state = join(root, "spikes", "state", `integration-${runId}`)
mkdirSync(state, { recursive: true })
const result: { started: string; runtime: string; project: string; checks: string[]; receipts: { hash: Hex; block: string; feeWei: string }[]; [key: string]: unknown } = { started: new Date().toISOString(), runtime: process.version, project: `veil-sdk-${runId}`, checks: [], receipts: [] }
const save = () => writeFileSync(join(state, "result.json"), JSON.stringify(result, null, 2))
const check = (name: string, ok: unknown) => { assert.ok(ok, name); result.checks.push(name); save(); console.log(`PASS ${name}`) }
const env = readFileSync(join(root, "spikes", ".env"), "utf8")
const privateKey = env.match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)?.[1] as Hex | undefined
if (!privateKey) throw Error("Missing throwaway SPIKE_PRIVATE_KEY in gitignored spikes/.env")
const account = privateKeyToAccount(privateKey)
const rpcUrl = tiramisu.rpcUrls.default.http[0]
const accessKey = process.env.ARKIV_ACCESS_KEY // config.ts loads the local server environment; never sent to browser.
const fetchOptions = accessKey ? { headers: { "X-API-KEY": accessKey } } : {}
const reader = createPublicClient({ chain: tiramisu, cacheTime: 0, transport: http(rpcUrl, { retryCount: 0, fetchOptions }) })
let admitted = 0n
const wallet = createWalletClient({ chain: tiramisu, account, transport: cfg => {
  const transport = http(rpcUrl, { retryCount: 0, fetchOptions })(cfg)
  const request = (async (args: Parameters<typeof transport.request>[0]) => {
    if (args.method === "eth_sendRawTransaction") {
      const raw = (args.params as [Hex])[0], tx = parseTransaction(raw)
      admitted += tx.gas! * (tx.maxFeePerGas ?? tx.gasPrice!) + (tx.value ?? 0n)
      if (admitted > parseEther("0.05")) throw Error("Integration maximum admitted fee/value cap 0.05 GLM reached")
      appendFileSync(join(state, "submissions.jsonl"), JSON.stringify({ hash: keccak256(raw), raw }) + "\n", { mode: 0o600, flush: true })
    }
    return transport.request(args)
  }) as typeof transport.request
  return { ...transport, request }
} })
const coordinator = new WriteQueue()
async function receipt(hash: Hex) {
  const r = await reader.getTransactionReceipt({ hash })
  check("confirmed native transaction", r.status === "success" && r.from.toLowerCase() === account.address.toLowerCase())
  if (!result.receipts.some(v => v.hash === hash)) result.receipts.push({ hash, block: r.blockNumber.toString(), feeWei: (r.gasUsed * r.effectiveGasPrice).toString() })
  save(); return r
}
const vaults = Array.from({ length: 4 }, () => KeyVault.random(result.project))
writeFileSync(join(state, "recovery.json"), JSON.stringify(vaults.map(v => v.recoveryCode)), { mode: 0o600 })
const rules: SemaphoreRules = { version: 1, chainId: 7738577, depth: 3, minMembers: 3, maxRootAgeBlocks: 3000, scope: { kind: "fixed", id: "synthetic-reporting-demo" } }
let relayer: ReturnType<typeof startRelayer> | undefined
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const html = join(root, "apps/demo/.veil-semaphore-test.html"), source = join(root, "apps/demo/.veil-semaphore-test.ts")
if (existsSync(html) || existsSync(source)) throw Error("Temporary test page already exists; inspect before rerunning")
try {
  check("Tiramisu chain", await reader.getChainId() === 7738577)
  const startBalance = await reader.getBalance({ address: account.address })
  check("throwaway account funded", startBalance > parseEther("0.05"))
  const artifactDir = join(root, "spikes/s1-semaphore-node/artifacts")
  mkdirSync(artifactDir, { recursive: true })
  for (const [ext, digest] of [["wasm", "48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2"], ["zkey", "c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3"]]) {
    const file = join(artifactDir, `semaphore-3.${ext}`)
    if (!existsSync(file)) { const r = await fetch(`https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.${ext}`, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw Error(`Artifact download HTTP ${r.status}`); writeFileSync(file, new Uint8Array(await r.arrayBuffer())) }
    check(`self-hosted ${ext} digest`, createHash("sha256").update(readFileSync(file)).digest("hex") === digest)
  }
  const created = await createSemaphoreGroup({ reader, wallet, coordinator, project: result.project, rules, expires: 86400 })
  await receipt(created.txHash)
  result.group = created.group
  await assert.rejects(createSemaphoreReader(reader, created.group, { trustedRelayers: [account.address] }).getSnapshot(), /insufficient/)
  check("empty groups cannot authorize proofs", true)
  const enrollment = await addSemaphoreMembers({ reader, wallet, coordinator, group: created.group, members: await Promise.all(vaults.slice(0, 3).map(v => v.vault.membershipCommitment(created.group))), expires: 86400 })
  await receipt(enrollment.txHash)
  const groupFile = join(state, "groups.json")
  writeFileSync(groupFile, JSON.stringify([created.group]))
  relayer = startRelayer(loadConfig({ RELAYER_PRIVATE_KEY: privateKey, RELAYER_KEY_VAR: "RELAYER_PRIVATE_KEY", PORT: "0", MIN_BATCH: "1", MAX_WAIT_MS: "0", MIN_INTERVAL_BLOCKS: "0", HEARTBEAT: "off", OHTTP: "off", REQUIRE_TOKENS: "off", COVER_MIN_BATCH: "0", RATE_LIMIT_PER_MIN: "100", SEMAPHORE_GROUPS_FILE: groupFile, SEMAPHORE_JOURNAL: join(state, "admissions.jsonl") }), { publicClient: reader, walletClient: wallet as unknown as ArkivClients["walletClient"], address: account.address })
  await relayer.listen()
  const address = relayer.server.address()
  if (!address || typeof address === "string") throw Error("No relayer port")
  const url = `http://127.0.0.1:${address.port}`
  let original: Record<string, any> | undefined
  let lostAcknowledgement = false
  const client = await createPrivateClient({ app: result.project, vault: vaults[0].vault, relayers: [url], publicClient: reader, delayMs: [0, 0], rarityK: 0, pollMs: 250, semaphore: { group: created.group }, fetch: async (input, init) => {
    if (String(input).endsWith("/v1/records") && init?.body) original = JSON.parse(String(init.body))
    const response = await fetch(input, init)
    if (!lostAcknowledgement && String(input).includes("/v1/records/") && response.status === 200) {
      const body = await response.clone().json()
      if (body.state === "written") {
        lostAcknowledgement = true
        return new Response(JSON.stringify({ ...body, state: "failed", error: "Injected lost acknowledgement after confirmed write" }), { status: 200, headers: { "content-type": "application/json" } })
      }
    }
    return response
  } })
  const writeStart = performance.now()
  const post = await client.createEntity({ payload: new TextEncoder().encode("Synthetic SDK report"), contentType: "text/plain", expires: 3600, encrypt: true, attributes: { type: "report" } })
  result.nodeWriteMs = performance.now() - writeStart
  check("SDK proof-gated write and fresh owner", post.owner.toLowerCase() !== account.address.toLowerCase())
  check("lost acknowledgement recovers and verifies without resending", lostAcknowledgement && post.recovered)
  await receipt(post.txHash!)
  const mine = await client.myEntities()
  check("SDK recovery and decryption", mine.some(p => p.toText() === "Synthetic SDK report"))
  check("SDK ownership challenge", !!(await client.proveOwnership(post.entityKey, { challenge: "synthetic", verifier: "integration" })).signature)
  const row = await reader.getEntity(post.entityKey)
  check("readonly membership record", row.creationFlags.readonly)
  async function request(body: unknown) { const r = await fetch(url + "/v1/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  check("malformed null returns 400", (await request(null)).status === 400)
  check("valid replay returns 409", (await request(original)).status === 409)
  const fake = structuredClone(original!)
  const fakeEnvelope = JSON.parse(fake.envelope)
  fakeEnvelope.membership.proof.points.fill("0")
  const { pad: _fakePad, ...fakeBody } = fakeEnvelope
  fake.envelope = padEnvelope(fakeBody)
  check("fake proof returns 400", (await request(fake)).status === 400)
  const missing = structuredClone(original!)
  const missingEnvelope = JSON.parse(missing.envelope)
  delete missingEnvelope.membership
  const { pad: _missingPad, ...missingBody } = missingEnvelope
  missing.envelope = padEnvelope(missingBody)
  check("membership-required project rejects missing proof", (await request(missing)).status === 403)
  const badOwner = { ...original!, owner: vaults[3].vault ? (await vaults[3].vault.newRecord()).address : account.address }
  check("owner substitution rejected", (await request(badOwner)).status === 400)
  const independent = createSemaphoreReader(reader, created.group, { trustedRelayers: [account.address] })
  check("independent SDK reader accepts valid proof", (await independent.readPosts()).accepted.length === 1)

  // A temporary page in the existing frontend exercises the actual WorkerVault and browser SDK.
  writeFileSync(html, '<!doctype html><html><body>Temporary synthetic SDK test<script type="module" src="/.veil-semaphore-test.ts"></script></body></html>')
  writeFileSync(source, `import {WorkerVault,createPrivateClient} from 'arkognito';import {createPublicClient} from '@arkiv-network/sdk';import {tiramisu} from '@arkiv-network/sdk/chains';import {http} from 'viem';
    window.runMembership=async({code,app,group,relay})=>{const vault=await WorkerVault.fromRecoveryCode(code,app);try{const reader=createPublicClient({chain:tiramisu,transport:http(location.origin+'/test-rpc')});const client=await createPrivateClient({app,vault,publicClient:reader,relayers:[relay],rarityK:0,delayMs:[0,0],pollMs:250,semaphore:{group,snarkArtifacts:{wasm:location.origin+'/test-artifacts/semaphore-3.wasm',zkey:location.origin+'/test-artifacts/semaphore-3.zkey'}}});const t=performance.now();const post=await client.createEntity({payload:new TextEncoder().encode('Synthetic browser report'),contentType:'text/plain',expires:3600,encrypt:true,attributes:{type:'report'}});const mine=await client.myEntities();return {post,ms:performance.now()-t,decrypted:mine.some(p=>p.toText()==='Synthetic browser report'),commitment:await client.membershipCommitment()};}finally{vault.terminate();}};`)
  vite = await createViteServer({ root: join(root, "apps/demo"), configFile: join(root, "apps/demo/vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "synthetic-test-services", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url === "/test-rpc") {
        try { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json", ...(accessKey ? { "X-API-KEY": accessKey } : {}) }, body: Buffer.concat(chunks) }); res.statusCode = r.status; res.setHeader("content-type", "application/json"); res.end(await r.text()) } catch { res.statusCode = 503; res.end('{"error":"Test RPC unavailable"}') } return
      }
      if (req.url?.startsWith("/test-artifacts/")) { const name = req.url.split("/").at(-1)!; if (!/^semaphore-3\.(wasm|zkey)$/.test(name)) { res.statusCode = 404; res.end(); return } res.end(readFileSync(join(root, "spikes/s1-semaphore-node/artifacts", name))); return }
      next()
    })
  } }] })
  await vite.listen()
  try { browser = await chromium.launch({ headless: true }) } catch { browser = await chromium.launch({ headless: true, channel: "chrome" }) }
  result.browserVersion = browser.version()
  const page = await browser.newPage()
  page.on("pageerror", e => console.error("Browser error:", e.message))
  await page.goto(vite.resolvedUrls!.local[0] + ".veil-semaphore-test.html")
  await page.waitForFunction(() => typeof (window as any).runMembership === "function", { timeout: 60000 })
  const browserResult = await page.evaluate(args => (window as any).runMembership(args), { code: vaults[1].recoveryCode, app: result.project, group: created.group, relay: url })
  result.browserWriteMs = browserResult.ms
  check("browser worker proof, relay and decryption", browserResult.decrypted)
  check("browser recovered commitment matches admitted identity", browserResult.commitment === await vaults[1].vault.membershipCommitment(created.group))
  await receipt(browserResult.post.txHash)
  check("independent reader sees both SDK clients", (await independent.readPosts()).accepted.length === 2)

  // Test canonical history using valid owner-controlled synthetic fixtures.
  const snapshot = await independent.getSnapshot()
  const scope = semaphoreScope(created.group, rules, BigInt(snapshot.block))
  async function fixture(message: string, member = 2, selectedSnapshot = snapshot, seconds = 3600) {
    const attributes = { project: result.project, type: "synthetic-history" }
    const unsigned = { v: 1, app: result.project, ct: "text/plain", exp: seconds, enc: 0 as const, data: toBase64(new TextEncoder().encode(message)) }
    const proof = await vaults[member].vault.proveMembership({ snapshot: selectedSnapshot, scope, message: membershipMessage(created.group, selectedSnapshot.block, scope, account.address, unsigned, attributes) })
    const membership: Membership = { group: created.group.key, rootBlock: selectedSnapshot.block, proof }
    const all = { ...attributes, ...membershipAttributes(membership) }
    const sealed = await sealEnvelope({ signer: { address: account.address, signEnvelope: (body, attrs) => account.signMessage({ message: { raw: envelopeDigest(body, attrs) } }), signProof: async () => { throw Error("Unused") } }, app: result.project, payload: new TextEncoder().encode(message), contentType: "text/plain", attributes: all, expSeconds: seconds })
    const { pad: _pad, ...body } = sealed.envelope
    return { payload: new TextEncoder().encode(padEnvelope({ ...body, membership })), contentType: "application/json", attributes: all, flags: { readonly: true }, expires: ExpirationTime.fromSeconds(seconds) }
  }
  const first = await fixture("Synthetic first"), second = await fixture("Synthetic duplicate")
  const duplicate = await relayer.writer.run(() => wallet.executeBatch({ creates: [first, second] }))
  await receipt(duplicate.txHash)
  let read = await independent.readPosts()
  check("receipt chronology selects first valid nullifier", read.accepted.some(p => p.key === duplicate.createdEntities[0]) && read.rejected.some(p => p.key === duplicate.createdEntities[1]))
  const removed = await relayer.writer.run(() => wallet.deleteEntity({ entityKey: duplicate.createdEntities[0] }))
  await receipt(removed.txHash)
  read = await independent.readPosts()
  check("deletion preserves spent state without promoting duplicate", read.accepted.length === 2 && read.spent.some(p => p.key === duplicate.createdEntities[0] && !p.live))
  const added = await addSemaphoreMembers({ reader, wallet, coordinator: relayer.writer, group: created.group, members: [await vaults[3].vault.membershipCommitment(created.group)], expires: 86400 })
  await receipt(added.txHash)
  check("historical group remains unchanged after append", (await independent.getSnapshot(BigInt(snapshot.block))).members.length === 3 && (await independent.getSnapshot()).members.length === 4)
  const expirySnapshot = await independent.getSnapshot()
  const expiring = await fixture("Synthetic expiring winner", 3, expirySnapshot, 6)
  const lasting = await fixture("Synthetic expiry duplicate", 3, expirySnapshot)
  const expiryWrite = await relayer.writer.run(() => wallet.executeBatch({ creates: [expiring, lasting] }))
  const expiryReceipt = await receipt(expiryWrite.txHash)
  for (let i = 0; i < 20 && await reader.getBlockNumber({ cacheTime: 0 }) <= expiryReceipt.blockNumber + 3n; i++) await new Promise(r => setTimeout(r, 1000))
  read = await independent.readPosts()
  check("expiry preserves spent state without promoting duplicate", read.accepted.length === 2 && read.spent.some(p => p.key === expiryWrite.createdEntities[0] && !p.live) && read.rejected.some(p => p.key === expiryWrite.createdEntities[1]))
  const endBalance = await reader.getBalance({ address: account.address })
  const fees = result.receipts.reduce((sum, r) => sum + BigInt(r.feeWei), 0n)
  check("testnet fees reconcile", startBalance - endBalance === fees)
  result.totalFeeWei = fees.toString()
  result.verdict = "PASS"
} catch (e) {
  result.verdict = "FAIL"; result.error = (e as Error).stack; process.exitCode = 1; console.error((e as Error).stack)
  const causes: { name: string; message: string }[] = []
  for (let cause = (e as Error).cause; cause instanceof Error; cause = cause.cause) causes.push({ name: cause.name, message: cause.message })
  result.causes = causes
}
finally {
  await browser?.close(); await vite?.close(); await relayer?.close()
  for (const file of [html, source]) if (existsSync(file)) unlinkSync(file)
  result.temporaryFrontendRemoved = !existsSync(html) && !existsSync(source)
  save()
  console.log(JSON.stringify({ ...result, stateDirectory: state }, null, 2))
  // snarkjs' Node worker pool otherwise keeps this explicit integration process alive.
  process.exit(process.exitCode ?? 0)
}
