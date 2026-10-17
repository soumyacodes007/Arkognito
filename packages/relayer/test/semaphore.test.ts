import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FileAdmissionJournal, AdmissionError } from "../src/semaphore"
import { VerificationUnavailable } from "arkognito/semaphore"
import { Batcher, type BatchItem } from "../src/batcher"
import { WriteQueue, type ArkivClients } from "../src/arkiv"
import { spawnSync } from "node:child_process"

test("Semaphore journal: pending survives new instance, confirmed replays conflict, corrupt and locked fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "veil-membership-"))
  try {
    const file = join(dir, "journal.jsonl")
    const journal = new FileAdmissionJournal(file)
    journal.claim("group:scope:nullifier", "request-1")
    assert.throws(() => new FileAdmissionJournal(file).claim("group:scope:nullifier", "request-2"), (e: unknown) => e instanceof AdmissionError && e.status === 503)
    journal.confirm("group:scope:nullifier", "request-1", { id: "request-1", state: "written", txHash: `0x${"22".repeat(32)}` })
    assert.throws(() => journal.claim("group:scope:nullifier", "request-3"), (e: unknown) => e instanceof AdmissionError && e.status === 409)
    writeFileSync(file + ".lock", "stale")
    assert.throws(() => journal.claim("other", "request-4"), VerificationUnavailable)
    rmSync(file + ".lock")
    writeFileSync(file, "{truncated")
    assert.throws(() => journal.claim("other", "request-5"), VerificationUnavailable)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("Semaphore journal: actual process exit after reservation prevents replay in a new process", () => {
  const dir = mkdtempSync(join(tmpdir(), "veil-membership-process-"))
  try {
    const file = join(dir, "journal.jsonl")
    const moduleUrl = new URL("../src/semaphore.ts", import.meta.url).href
    const script = `const {FileAdmissionJournal}=await import(${JSON.stringify(moduleUrl)});new FileAdmissionJournal(${JSON.stringify(file)}).claim('synthetic:scope:nullifier','request');process.exit(77)`
    const child = spawnSync(process.execPath, ["--conditions=arkognito-source", "--import", "tsx", "--input-type=module", "--eval", script], { timeout: 30000, encoding: "utf8" })
    assert.equal(child.status, 77, child.stderr)
    assert.throws(() => new FileAdmissionJournal(file).claim("synthetic:scope:nullifier", "retry"), (e: unknown) => e instanceof AdmissionError && e.status === 503)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("Semaphore batches: uncertain send is never split/retried; final anonymity and hook failures cannot strand requests", async () => {
  let sends = 0
  const address = `0x${"11".repeat(20)}` as const
  const group = { project: "synthetic", admin: address, key: `0x${"22".repeat(32)}` as const, fromBlock: "1" }
  const clients = { address, publicClient: { getBlockNumber: async () => 10n, predictEntityKeys: async () => [{ key: group.key, salt: 1n }, { key: group.key, salt: 2n }] }, walletClient: { executeBatch: async () => { sends++; throw Object.assign(Error("Injected lost receipt"), { txHash: group.key }) } } } as unknown as ArkivClients
  const options = { minBatch: 1, maxBatch: 10, maxWaitMs: 0, minIntervalBlocks: 0, evil: "none" as const, log: () => {} }
  const item = (id: string): BatchItem => ({ id, owner: address, envelope: "{}", attributes: { project: "synthetic" }, expSeconds: 3600, receivedAt: 0, membership: { id, group } })
  const uncertain = new Batcher(clients, new WriteQueue(), options)
  uncertain.enqueue(item("a")); uncertain.enqueue(item("b"))
  await uncertain.tick()
  assert.equal(sends, 1)
  assert.equal(uncertain.status.get("a")?.txHash, group.key)
  assert.equal(uncertain.status.get("b")?.state, "failed")
  await uncertain.tick(); assert.equal(sends, 1)
  const small = new Batcher(clients, new WriteQueue(), options, { beforeWrite: async items => ({ keep: items.filter(it => it.id === "c"), reject: items.filter(it => it.id !== "c").map(item => ({ item, error: "Injected rejection" })) }) })
  small.enqueue({ ...item("c"), minAnonymity: 2 }); small.enqueue(item("d"))
  await small.tick(); assert.equal(sends, 1); assert.equal(small.status.get("c")?.state, "failed")
  const unavailable = new Batcher(clients, new WriteQueue(), options, { beforeWrite: async () => { throw Error("Injected provider outage") } })
  unavailable.enqueue(item("e")); await unavailable.tick()
  assert.equal(unavailable.status.get("e")?.state, "failed"); assert.equal(sends, 1)
  const receiptFailure = {
    ...clients,
    publicClient: { ...clients.publicClient, predictEntityKeys: async () => [{ key: group.key, salt: 1n }], getTransactionReceipt: async () => { throw Error("Injected receipt provider outage") } },
    walletClient: { executeBatch: async () => { sends++; return { txHash: group.key, createdEntities: [group.key] } } },
  } as unknown as ArkivClients
  const afterSend = new Batcher(receiptFailure, new WriteQueue(), options)
  afterSend.enqueue(item("f")); await afterSend.tick()
  assert.equal(sends, 2)
  assert.equal(afterSend.status.get("f")?.state, "failed")
  assert.equal(afterSend.status.get("f")?.txHash, group.key)
  await afterSend.tick(); assert.equal(sends, 2)
})
