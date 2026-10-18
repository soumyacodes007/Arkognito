// The Campus Voice story server. It plays everyone except the student in the browser:
//   the student union (admits members), the shared relayer (sends reports to Arkiv), four synthetic
//   classmates, and the complaints committee (reads reports, verifies ownership proofs).
// The browser is the student's device: its vault, recovery code and proofs never come here.
//   npm run server -w campus-voice     (Vite proxies /api, /relay and /rpc to this process)
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize } from "node:path"
import { bytesToHex, hexToBytes, type Hex } from "viem"
import { newRequesterKey, verifyOwnershipProof } from "arkognito"
import {
  type Campus,
  PROFESSORS,
  type ProfessorId,
  ROOT,
  STATE,
  addMembers,
  committeeView,
  createCampus,
  enroll,
  explorer,
  newStudent,
  patientFetch,
  reader,
  relayerWallet,
  sealReport,
  startCampusRelayer,
  studentClient,
  union,
} from "./campus"
import { NULLIFIER_SEED, makeTestCard, testCertificate, verifyJoin } from "./aadhaar"

const PORT = Number(process.env.CAMPUS_API_PORT ?? process.env.PORT ?? 8790)
const RELAY_PORT = Number(process.env.CAMPUS_RELAY_PORT ?? 8791)
const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const accessKey = process.env.CAMPUS_ARKIV_ACCESS_KEY || undefined
const ARTIFACTS = join(ROOT, "spikes/s1-semaphore-node/artifacts")
// Deployed (CAMPUS_STATIC=on), this one port also serves the built page and forwards /relay, as Vite does locally.
const STATIC = process.env.CAMPUS_STATIC === "on" ? join(ROOT, "apps/campus-voice/dist") : ""
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png" }
const MAX_MEMBERS = 8 // depth-3 groups
const CURRENT = join(STATE, "current.json")

/** Synthetic reports the four classmates file about Professor A. */
const CLASSMATE_REPORTS = [
  "Professor A mocked a student's question in front of the whole class.",
  "Professor A said students who complain will get lower grades.",
  "Professor A keeps making comments about students' appearance.",
  "Professor A singled me out again and again during the lab.",
]

type Saved = {
  campus: Campus
  classmates: string[] // synthetic recovery codes: these students exist only in this demo
  committee: { secret: Hex; publicKey: Hex }
  members: number
  classmateReports: Record<number, { entityKey: Hex; owner: Hex; txHash: Hex }>
  /** Anon Aadhaar nullifiers of cards that joined. Local only: never written to Arkiv. */
  usedNullifiers?: string[]
  createdAt: string
}

let saved: Saved
let ready: Promise<void> = Promise.resolve()
let isReady = false
let setupError = ""
let relay: Awaited<ReturnType<typeof startCampusRelayer>> | undefined
let busy: Promise<unknown> = Promise.resolve()
/** One story action at a time: the union and the relayer each sign from one wallet. */
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = busy.then(fn, fn)
  busy = next.catch(() => undefined)
  return next
}

const persist = () => writeFileSync(CURRENT, JSON.stringify(saved, null, 2), { mode: 0o600 })

async function newStory() {
  const run = Date.now().toString(36)
  console.log(`[campus] new story ${run}: creating one group per professor and enrolling 4 classmates…`)
  const campus = await createCampus(run)
  const classmates = Array.from({ length: 4 }, newStudent)
  await enroll(campus, classmates)
  const k = newRequesterKey()
  saved = { campus, classmates, committee: { secret: bytesToHex(k.secret), publicKey: k.publicKey }, members: classmates.length, classmateReports: {}, createdAt: new Date().toISOString() }
  mkdirSync(join(STATE, run), { recursive: true })
  persist()
}

async function startRelay() {
  await relay?.close()
  relay = await startCampusRelayer(saved.campus, join(STATE, saved.campus.run), RELAY_PORT)
  console.log(`[campus] relayer for story ${saved.campus.run} on :${RELAY_PORT}`)
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
}
async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 200_000) throw new Error("request too large")
  }
  return raw
}
const isProf = (p: string): p is ProfessorId => PROFESSORS.some((x) => x.id === p)

function campusInfo() {
  const c = saved.campus
  return {
    run: c.run,
    createdAt: saved.createdAt,
    professors: PROFESSORS.map((p) => ({ ...p, group: c.groups[p.id] })),
    union: union.account.address,
    relayer: relayerWallet.account.address,
    committeeKey: saved.committee.publicKey,
    members: saved.members,
    maxMembers: MAX_MEMBERS,
    setup: c.txs.map((t) => ({ label: t.label, url: explorer.tx(t.hash) })),
    classmatesDone: Object.keys(saved.classmateReports).length,
    aadhaar: { nullifierSeed: NULLIFIER_SEED, testOnly: true },
  }
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, arg?: string) => Promise<void>> = {
  "GET /api/campus": async (_req, res) => json(res, 200, campusInfo()),

  // A synthetic Anon Aadhaar TEST card for the visitor to scan. Real cards are refused at /api/join.
  "GET /api/test-card": async (_req, res) => json(res, 200, { qr: await makeTestCard(), test: true }),
  "GET /api/aadhaar-certificate": async (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(await testCertificate())
  },

  // The student's device sends one commitment per professor group and an Anon Aadhaar proof bound to
  // them. The union verifies the proof, refuses a card that already joined, then adds the commitments.
  "POST /api/join": async (req, res) => {
    const { commitments, anonAadhaar } = JSON.parse(await readBody(req)) as { commitments: Record<string, string>; anonAadhaar: any }
    for (const p of PROFESSORS) if (!/^\d{1,80}$/.test(commitments?.[p.id] ?? "")) return json(res, 400, { error: `missing commitment for ${p.name}` })
    if (saved.members >= MAX_MEMBERS) return json(res, 409, { error: "This demo campus is full. Start a new story." })
    const out = await serial(async () => {
      const check = await verifyJoin(anonAadhaar, commitments, new Set(saved.usedNullifiers ?? []))
      if (!check.ok) return { error: check.reason }
      const txs: { prof: string; url: string }[] = []
      for (const p of PROFESSORS) txs.push({ prof: p.name, url: explorer.tx(await addMembers(saved.campus, p.id, [commitments[p.id]])) })
      saved.usedNullifiers = [...(saved.usedNullifiers ?? []), check.nullifier]
      saved.members++
      persist()
      return { txs, members: saved.members, nullifier: check.nullifier }
    })
    if ("error" in out) return json(res, 403, out)
    json(res, 200, out)
  },

  // Classmate i (0..3) reports Professor A, from their own synthetic vault, through the same relayer.
  "POST /api/classmate": async (_req, res, arg) => {
    const i = Number(arg)
    if (!(i >= 0 && i < CLASSMATE_REPORTS.length)) return json(res, 400, { error: "no such classmate" })
    const done = await serial(async () => {
      if (saved.classmateReports[i]) return saved.classmateReports[i]
      const client = await studentClient(saved.classmates[i], saved.campus.groups["prof-a"], `http://127.0.0.1:${RELAY_PORT}`)
      try {
        const r = await client.createEntity({ payload: sealReport(CLASSMATE_REPORTS[i], saved.committee.publicKey), contentType: "application/json", attributes: { type: "report" }, expires: 7 * 86400 })
        saved.classmateReports[i] = { entityKey: r.entityKey, owner: r.owner, txHash: r.txHash! }
      } catch (e) {
        // A slow Arkiv can make the reply arrive after we gave up, though the report was written. The
        // relayer then refuses a retry because this classmate's tag is already published: that is done.
        if (!/already published/i.test((e as Error).message)) throw e
        saved.classmateReports[i] = { entityKey: "" as Hex, owner: "" as Hex, txHash: "" as Hex }
      }
      persist()
      return saved.classmateReports[i]
    })
    json(res, 200, { ...done, url: done.entityKey ? explorer.entity(done.entityKey) : "" })
  },

  // What the complaints committee sees: verified reports, decrypted, and how many distinct students.
  "GET /api/committee": async (_req, res, arg) => {
    if (!arg || !isProf(arg)) return json(res, 400, { error: "unknown professor" })
    const view = await committeeView(saved.campus.groups[arg], relayerWallet.account.address, hexToBytes(saved.committee.secret))
    json(res, 200, {
      distinctStudents: view.distinctStudents,
      reports: view.reports.map((r) => ({ ...r, url: explorer.entity(r.key), ownerUrl: explorer.address(r.owner) })),
      rejected: view.rejected.length,
    })
  },

  // The committee checks a student's proof that they own a report.
  "POST /api/verify": async (req, res) => {
    const { proof, challenge } = JSON.parse(await readBody(req))
    const verdict = await verifyOwnershipProof(proof, { challenge, verifier: "complaints-committee", client: reader as any })
    json(res, 200, verdict)
  },

  "POST /api/reset": async (_req, res) => {
    await serial(async () => {
      await newStory()
      await startRelay()
    })
    json(res, 200, campusInfo())
  },

  // Arkiv reads for the browser, with the access key added here so it never reaches the page.
  "POST /rpc": async (req, res) => {
    const r = await patientFetch(RPC, { method: "POST", headers: { "content-type": "application/json", ...(accessKey ? { "X-API-KEY": accessKey } : {}) }, body: await readBody(req), signal: AbortSignal.timeout(90_000) })
    res.writeHead(r.status, { "content-type": "application/json" })
    res.end(await r.text())
  },

  // Semaphore proving files for the browser (digest-checked by the repo's live Semaphore test).
  "GET /artifacts": async (_req, res, arg) => {
    if (!arg || !/^semaphore-3\.(wasm|zkey)$/.test(arg)) return json(res, 404, { error: "not found" })
    res.writeHead(200, { "content-type": arg.endsWith(".wasm") ? "application/wasm" : "application/octet-stream", "cache-control": "max-age=86400" })
    res.end(readFileSync(join(ARTIFACTS, arg)))
  },
}

const server = createServer(async (req, res) => {
  const [path] = (req.url ?? "/").split("?")
  const parts = path.split("/").filter(Boolean) // e.g. ["api", "committee", "prof-a"]
  const base = `/${parts.slice(0, 2).join("/")}`
  const handler = routes[`${req.method} ${path}`] ?? routes[`${req.method} ${base}`] ?? routes[`${req.method} /${parts[0]}`]
  const arg = routes[`${req.method} ${path}`] ? undefined : parts[parts.length - 1]
  if (path === "/healthz") return json(res, 200, { ok: true, ready: isReady, error: setupError || undefined })
  if (STATIC && parts[0] === "relay") return forwardToRelay(req, res)
  if (!handler && STATIC && req.method === "GET") return serveStatic(path, res)
  if (!handler) return json(res, 404, { error: "not found" })
  if (!isReady && path.startsWith("/api/")) return json(res, 503, { error: setupError ? `Setup failed: ${setupError}` : "Setting up the campus on Arkiv…", setup: !setupError })
  try {
    await handler(req, res, arg)
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    console.error(`[campus] ${req.method} ${path}: ${msg.split("\n")[0]}`)
    if (!res.headersSent) json(res, 500, { error: msg.split("\n")[0].slice(0, 300) })
  }
})

function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path).replace(/^([/\\]|\.\.[/\\])+/, "")
  let file = join(STATIC, rel)
  if (!file.startsWith(STATIC) || !existsSync(file) || statSync(file).isDirectory()) file = join(STATIC, "index.html") // client-side routes
  const type = MIME[extname(file)] ?? "application/octet-stream"
  res.writeHead(200, { "content-type": type, "cache-control": file.includes("/assets/") || file.includes("\\assets\\") ? "max-age=31536000, immutable" : "no-cache" })
  res.end(readFileSync(file))
}

async function forwardToRelay(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req)
    const r = await fetch(`http://127.0.0.1:${RELAY_PORT}${(req.url ?? "/").replace(/^\/relay/, "") || "/"}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body,
      signal: AbortSignal.timeout(120_000),
    })
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" })
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    if (!res.headersSent) json(res, 502, { error: `relayer unavailable: ${(e as Error).message}` })
  }
}

mkdirSync(STATE, { recursive: true })
if (!existsSync(join(ARTIFACTS, "semaphore-3.wasm"))) console.warn("[campus] proving files missing: run `npm run test:semaphore:live` once, or download them (see docs/semaphore.md)")
// Listen at once; story routes answer 503 "setting up" until the campus exists.
server.listen(PORT, () => console.log(`[campus] story server on :${PORT} · union ${union.account.address} · relayer ${relayerWallet.account.address}`))
ready = (async () => {
  if (existsSync(CURRENT)) {
    saved = JSON.parse(readFileSync(CURRENT, "utf8"))
    console.log(`[campus] resuming story ${saved.campus.run} (${saved.members} members)`)
  } else await newStory()
  await startRelay()
  isReady = true
})().catch((e) => {
  setupError = (e as Error).message.split(String.fromCharCode(10))[0]
  console.error(`[campus] setup failed: ${setupError}`)
})

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    server.close()
    await relay?.close()
    process.exit(0)
  })
