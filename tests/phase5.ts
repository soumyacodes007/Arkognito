// Phase 5 test (PRD §8):
//  - The Sketch App becomes private by changing 3 code lines or fewer.
//  - check() flags a timestamp attribute and a 6-decimal coordinate.
//  - End to end against the local relayer network (npm run dev:relayers): the public Sketch App
//    calls vs the private ones, with the Arkiv SDK's own wallet client, relayer discovery and
//    automatic blind tokens, then what an observer sees.
import { readFileSync } from "node:fs"
import { ExpirationTime, createWalletClient, jsonToPayload } from "@arkiv-network/sdk"
import { dec, i32 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { checkRecord, createPrivateClient } from "arkognito"
import { http, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { check, done, publicClient } from "./helpers"

const PROJECT = "arkognito-demo-sketch"

// ---- 1. three lines ----------------------------------------------------------------------
const code = (f: string) =>
  readFileSync(`apps/demo/src/${f}`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("//"))
const pub = code("store-public.ts")
const priv = code("store-private.ts")
const changed = priv.filter((l) => !pub.includes(l)).length
const removed = pub.filter((l) => !priv.includes(l)).length
check("Sketch App goes private by changing 3 code lines or fewer", changed <= 3 && removed <= 3, `${changed} added/changed, ${removed} replaced`)

// ---- 2. fingerprint guard ----------------------------------------------------------------
const tutorialAttrs = { project: PROJECT, type: "sketch", timestamp: Date.now() > 2 ** 31 ? i32(1_760_000_000) : i32(Date.now()) }
const w = checkRecord({ attributes: { ...tutorialAttrs, lat: dec("18.520430") }, expires: ExpirationTime.fromDays(365) })
check("check() flags the tutorial's exact timestamp attribute", w.some((x) => x.code === "timestamp" && x.attribute === "timestamp"))
check("check() flags a 6-decimal coordinate", w.some((x) => x.code === "precise-location" && x.attribute === "lat"))
check("check() flags an expiry past the 90-day bucket (tutorial uses 365 days)", w.some((x) => x.code === "expiry-too-long"))

// ---- 3. public flow: the user's wallet creates and owns each sketch --------------------------
const rpc = http(process.env.ARKIV_RPC_URL)
const demoUser = privateKeyToAccount(process.env.DEMO_USER_PRIVATE_KEY as Hex)
const strokes = () =>
  Array.from({ length: 3 }, () => Array.from({ length: 40 + Math.floor(Math.random() * 20) }, () => Math.floor(Math.random() * 256)))
const publicWallet = createWalletClient({ chain: tiramisu, transport: rpc, account: demoUser })
for (let i = 0; i < 3; i++) {
  await publicWallet.createEntity({
    payload: jsonToPayload({ strokes: strokes() }),
    contentType: "application/json",
    attributes: { project: PROJECT, type: "sketch" },
    expires: ExpirationTime.fromDays(30),
  })
}
const ownedPublic = await publicClient.select({ key: true }).where(eq("project", PROJECT), eq("type", "sketch")).ownedBy(demoUser.address).fetch()
check("public: one owner query on the user's wallet lists their sketches", ownedPublic.entities.length >= 3, `${ownedPublic.entities.length} found`)

// ---- 4. private flow: same calls through Arkognito, 5 users ---------------------------------------
const users = [demoUser, ...Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()))]
const started = Date.now()
const perUser = await Promise.all(
  users.map(async (account) => {
    // Exactly the store-private.ts line: the Arkiv SDK's wallet client, no relayer list (discovery), tokens automatic.
    const arkiv = await createPrivateClient({ app: PROJECT, wallet: createWalletClient({ chain: tiramisu, transport: rpc, account }), publicClient, delayMs: [0, 5000] })
    const saved = []
    for (let i = 0; i < 2; i++) {
      saved.push(
        await arkiv.createEntity({
          payload: jsonToPayload({ strokes: strokes() }),
          contentType: "application/json",
          attributes: { project: PROJECT, type: "sketch" },
          expires: ExpirationTime.fromDays(30),
        }),
      )
    }
    const mine = await arkiv.myEntities({ where: { type: "sketch" } })
    return { account, arkiv, saved, mine }
  }),
)
console.log(`10 private sketches in ${Math.round((Date.now() - started) / 1000)} s`)
const demo = perUser[0]
check("private: relayers discovered from Arkiv, tokens fetched automatically, writes landed", perUser.every((u) => u.saved.length === 2))
check("private: myEntities() finds each user's own sketches", perUser.every((u) => u.saved.every((s) => u.mine.some((m) => m.key === s.entityKey))))
check("private: records decode like SDK entities (key + toJson)", Array.isArray(demo.mine[0]?.toJson().strokes))
const ownedAfter = await publicClient.select({ key: true }).where(eq("project", PROJECT), eq("type", "sketch")).ownedBy(demoUser.address).fetch()
check("private: the owner query on the wallet finds no new sketch", ownedAfter.entities.length === ownedPublic.entities.length,
  `${ownedAfter.entities.length} (the public ones only)`)
const batchSizes = perUser.flatMap((u) => u.saved.map((s) => s.batchSize ?? 0))
check("private: sketches landed in shared batches", batchSizes.some((b) => b > 1), `batch sizes ${batchSizes.join(",")}`)

// ---- 5. observer -------------------------------------------------------------------------
const rows: { owner: string; creator: string; size: number }[] = []
for await (const e of publicClient.select({ owner: true, creator: true, payload: true }).where(eq("project", PROJECT)).limit(200)) {
  rows.push({ owner: e.owner.toLowerCase(), creator: e.creator.toLowerCase(), size: e.payload.length })
}
const hidden = rows.filter((r) => r.owner !== r.creator)
const perOwner = new Map<string, number>()
for (const r of hidden) perOwner.set(r.owner, (perOwner.get(r.owner) ?? 0) + 1)
check("observer: every Arkognito sketch has its own owner", Math.max(...perOwner.values()) === 1, `${hidden.length} Arkognito sketches`)
check("observer: Arkognito sketches come only from relayers", new Set(hidden.map((r) => r.creator)).size <= 2)
check("observer: Arkognito sketch sizes fall in padding buckets", hidden.every((r) => [256, 1024, 4096, 16384].includes(r.size)),
  [...new Set(hidden.map((r) => r.size))].join("/"))

done()
process.exit()
