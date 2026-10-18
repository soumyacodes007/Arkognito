// Campus Voice: the story pieces shared by the flow script and the demo server.
// Students report professors anonymously. A student union admits members to one Semaphore group per
// professor (a group's scope is fixed, so "one report per student per professor" means one group per
// professor). Reports go through a shared relayer to fresh owner addresses, and are encrypted to the
// complaints committee's key so the committee can read them while the student still owns the record.
// Everything here is synthetic: invented students, invented professors, testnet only.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Address, type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { KeyVault, createPrivateClient, decryptShare, encryptShare, fromBase64 } from "arkognito"
import {
  type SemaphoreGroup,
  type SemaphoreRules,
  SemaphoreWriteQueue,
  addSemaphoreMembers,
  createSemaphoreGroup,
  createSemaphoreReader,
} from "arkognito/semaphore"
import type { ArkivClients } from "../../../packages/relayer/src/arkiv"
import { loadConfig } from "../../../packages/relayer/src/config"
import { startRelayer } from "../../../packages/relayer/src/server"

export const ROOT = resolve(import.meta.dirname, "../../..")
export const STATE = resolve(import.meta.dirname, "../.state")
export const EXPLORER = "https://tiramisu.explorer.arkiv.network"
export const explorer = {
  tx: (h: string) => `${EXPLORER}/tx/${h}`,
  entity: (k: string) => `${EXPLORER}/entity/${k}`,
  address: (a: string) => `${EXPLORER}/address/${a}`,
}

export const PROFESSORS = [
  { id: "prof-a", name: "Professor A", course: "Organic Chemistry" },
  { id: "prof-b", name: "Professor B", course: "Linear Algebra" },
] as const
export type ProfessorId = (typeof PROFESSORS)[number]["id"]

/** One project (app) per professor: the relayer allows one Semaphore group per project. */
export const projectFor = (run: string, prof: ProfessorId) => `campus-voice-${run}-${prof}`

export const rulesFor = (prof: ProfessorId): SemaphoreRules => ({
  version: 1,
  chainId: 7738577,
  depth: 3, // up to 8 members
  minMembers: 3,
  maxRootAgeBlocks: 3000,
  scope: { kind: "fixed", id: `report-${prof}` },
})

process.loadEnvFile(join(ROOT, ".env"))
// Optional app-level settings (gitignored), e.g. CAMPUS_ARKIV_ACCESS_KEY.
const appEnv = resolve(import.meta.dirname, "../.env")
if (existsSync(appEnv)) process.loadEnvFile(appEnv)
const rpcUrl = tiramisu.rpcUrls.default.http[0]
// Server-side only. CAMPUS_ARKIV_ACCESS_KEY wins (this repo's ARKIV_ACCESS_KEY was rejected with 401 on
// 18 Oct); without a key, reads use Arkiv's anonymous budget, which a full run can exhaust (429).
const accessKey = process.env.CAMPUS_ARKIV_ACCESS_KEY || undefined
/**
 * Arkiv's RPC can be slow: on 18 Oct, queries at past blocks took 20–30 s and some ended in 504. So
 * each request may take up to 60 s and is retried twice after a gateway error. A 429 is never retried
 * here (viem would otherwise wait out a Retry-After of nearly an hour, which looks like a hang).
 */
export const patientFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init)
    if (attempt < 2 && (res.status === 502 || res.status === 503 || res.status === 504)) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      continue
    }
    return res
  }
}
const transport = () =>
  http(rpcUrl, { retryCount: 0, timeout: 60_000, fetchFn: patientFetch, ...(accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {}) })
export const reader = createPublicClient({ chain: tiramisu, cacheTime: 0, transport: transport() })

function walletFrom(envName: string) {
  const key = process.env[`${envName}_PRIVATE_KEY`] as Hex | undefined
  if (!key) throw new Error(`${envName}_PRIVATE_KEY is missing from the repo's .env`)
  const account = privateKeyToAccount(key)
  return { key, account, wallet: createWalletClient({ chain: tiramisu, account, transport: transport() }) }
}
/** The student union admits members. It is not the relayer, and it never sees who reports. */
export const union = walletFrom("TEST_RELAYER_B")
/** The shared relayer: the creator of every report on Arkiv, whoever wrote it. */
export const relayerWallet = walletFrom("TEST_RELAYER_A")
const unionQueue = new SemaphoreWriteQueue()

export type Campus = {
  run: string
  groups: Record<ProfessorId, SemaphoreGroup>
  /** Group creation and enrollment transactions, for explorer links. */
  txs: { label: string; hash: Hex }[]
}

/** The union creates one group per professor. Members are added as students join. */
export async function createCampus(run: string): Promise<Campus> {
  const groups = {} as Record<ProfessorId, SemaphoreGroup>
  const txs: Campus["txs"] = []
  for (const p of PROFESSORS) {
    const created = await createSemaphoreGroup({
      reader: reader as any,
      wallet: union.wallet as any,
      coordinator: unionQueue,
      project: projectFor(run, p.id),
      rules: rulesFor(p.id),
      expires: 7 * 86400,
    })
    groups[p.id] = created.group
    txs.push({ label: `group for ${p.name}`, hash: created.txHash })
  }
  return { run, groups, txs }
}

/** The union adds membership commitments to one professor's group. Commitments reveal nothing about who. */
export async function addMembers(campus: Campus, prof: ProfessorId, commitments: string[]): Promise<Hex> {
  const res = await addSemaphoreMembers({ reader: reader as any, wallet: union.wallet as any, coordinator: unionQueue, group: campus.groups[prof], members: commitments, expires: 7 * 86400 })
  return res.txHash
}

/** Students join with their recovery codes (used for synthetic classmates; real students send commitments). */
export async function enroll(campus: Campus, recoveryCodes: string[]): Promise<Hex[]> {
  const hashes: Hex[] = []
  for (const p of PROFESSORS) {
    const group = campus.groups[p.id]
    const members = await Promise.all(recoveryCodes.map((code) => KeyVault.fromRecoveryCode(code, group.project).membershipCommitment(group)))
    hashes.push(await addMembers(campus, p.id, members))
  }
  return hashes
}

export function newStudent() {
  return KeyVault.random("campus-voice").recoveryCode
}

/** Starts a relayer that accepts reports only with a valid membership proof for these groups. */
export async function startCampusRelayer(campus: Campus, dir = join(STATE, campus.run), port = 0) {
  mkdirSync(dir, { recursive: true })
  const groupsFile = join(dir, "groups.json")
  writeFileSync(groupsFile, JSON.stringify(Object.values(campus.groups)))
  const relayer = startRelayer(
    loadConfig({
      RELAYER_PRIVATE_KEY: relayerWallet.key,
      RELAYER_KEY_VAR: "RELAYER_PRIVATE_KEY",
      PORT: String(port),
      MIN_BATCH: "1",
      MAX_WAIT_MS: "0",
      MIN_INTERVAL_BLOCKS: "0",
      HEARTBEAT: "off",
      OHTTP: "off",
      REQUIRE_TOKENS: "off",
      COVER_MIN_BATCH: "0",
      RATE_LIMIT_PER_MIN: "200",
      SEMAPHORE_GROUPS_FILE: groupsFile,
      SEMAPHORE_JOURNAL: join(dir, "admissions.jsonl"),
    }),
    { publicClient: reader as any, walletClient: relayerWallet.wallet as unknown as ArkivClients["walletClient"], address: relayerWallet.account.address },
  )
  await relayer.listen()
  const address = relayer.server.address()
  if (!address || typeof address === "string") throw new Error("relayer did not get a port")
  return { url: `http://127.0.0.1:${address.port}`, address: relayerWallet.account.address as Address, close: () => relayer.close() }
}

/** The app encrypts the report's text to the committee's key; the student still owns the record. */
export const sealReport = (text: string, committeeKey: Hex) =>
  new TextEncoder().encode(JSON.stringify({ v: 1, to: "committee", ...encryptShare(new TextEncoder().encode(text), committeeKey) }))

export function openReport(data: Uint8Array, committeeSecret: Uint8Array): string {
  const sealed = JSON.parse(new TextDecoder().decode(data))
  return new TextDecoder().decode(decryptShare(committeeSecret, sealed))
}

/** A student's client for one professor. The same recovery code works for every professor. */
export async function studentClient(code: string, group: SemaphoreGroup, relayerUrl: string) {
  return createPrivateClient({
    app: group.project,
    vault: KeyVault.fromRecoveryCode(code, group.project),
    relayers: [relayerUrl],
    publicClient: reader as any,
    delayMs: [0, 0],
    rarityK: 0,
    pollMs: 500,
    semaphore: { group },
  })
}

/** What the committee sees for one professor: verified reports, decrypted, and how many distinct students. */
export async function committeeView(group: SemaphoreGroup, relayer: Address, committeeSecret: Uint8Array) {
  const feed = createSemaphoreReader(reader as any, group, { trustedRelayers: [relayer] })
  const { accepted, rejected } = await feed.readPosts()
  const reports = accepted.map((p) => ({
    key: p.key,
    owner: p.owner,
    creator: p.creator,
    txHash: p.txHash,
    nullifier: String(p.membership.proof.nullifier),
    text: (() => {
      try {
        return openReport(fromBase64(p.envelope.data), committeeSecret)
      } catch {
        return undefined
      }
    })(),
  }))
  return { reports, rejected, distinctStudents: new Set(reports.map((r) => r.nullifier)).size }
}
