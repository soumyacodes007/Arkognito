// The professor story, end to end on Tiramisu with the real SDK and relayer (synthetic data only).
//   npx tsx --conditions=arkognito-source apps/campus-voice/server/try-flow.ts
//
// 1. Students join through the student union      4. Trying again on the same professor is rejected
// 2. A student reports Professor A                 5. Their report on Professor B has another owner
// 3. On Arkiv: relayer is creator, fresh owner,     6. Four classmates report Professor A: 5 distinct students
//    report readable only by the committee          7. New device + recovery code: find it, prove it's theirs
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { newRequesterKey, verifyOwnershipProof } from "arkognito"
import { STATE, committeeView, createCampus, enroll, explorer, newStudent, reader, relayerWallet, sealReport, startCampusRelayer, studentClient, union } from "./campus"

const run = Date.now().toString(36)
let failed = 0
const out: Record<string, unknown> = { run, started: new Date().toISOString(), beats: [] as unknown[] }
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}
const beat = (title: string) => console.log(`\n── ${title}`)
const link = (label: string, url: string) => console.log(`   ${label}: ${url}`)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const committee = newRequesterKey() // the complaints committee's key pair (synthetic)
let relayer: Awaited<ReturnType<typeof startCampusRelayer>> | undefined
try {
  beat("1. Students join through the student union")
  const campus = await createCampus(run)
  const students = Array.from({ length: 6 }, newStudent) // synthetic students; codes stay in .state, never on Arkiv
  const enrolled = await enroll(campus, students)
  for (const t of campus.txs) link(t.label, explorer.tx(t.hash))
  for (const h of enrolled) link("6 students added", explorer.tx(h))
  link("student union (admin)", explorer.address(union.account.address))
  relayer = await startCampusRelayer(campus)
  link("shared relayer", explorer.address(relayer.address))
  writeFileSync(join(STATE, run, "students.json"), JSON.stringify(students), { mode: 0o600 })

  beat("2. Student 1 reports Professor A")
  const s1a = await studentClient(students[0], campus.groups["prof-a"], relayer.url)
  const report1 = "Synthetic: during office hours Professor A made repeated demeaning remarks about my accent."
  const r1 = await s1a.createEntity({ payload: sealReport(report1, committee.publicKey), contentType: "application/json", attributes: { type: "report" }, expires: 86400 })
  link("report on Arkiv", explorer.entity(r1.entityKey))
  link("transaction", explorer.tx(r1.txHash!))

  beat("3. What Arkiv shows")
  const row: any = await reader.getEntity(r1.entityKey)
  const raw = new TextDecoder().decode(row.payload)
  check("creator is the shared relayer, not the student", same(row.creator ?? "", relayer.address), row.creator)
  check("owner is a brand-new address", !same(r1.owner, relayer.address) && !same(r1.owner, union.account.address), r1.owner)
  check("the report text is not readable on Arkiv", !raw.includes("office hours") && !raw.includes("accent"))
  link("owner (fresh)", explorer.address(r1.owner))

  beat("4. Student 1 tries to report Professor A again")
  let rejection = ""
  try {
    await s1a.createEntity({ payload: sealReport("Synthetic: second report on the same professor.", committee.publicKey), contentType: "application/json", attributes: { type: "report" }, expires: 86400 })
  } catch (e) {
    rejection = (e as Error).message
  }
  check("a second report on the same professor is rejected", !!rejection, rejection.slice(0, 140))

  beat("5. Student 1 reports Professor B")
  const s1b = await studentClient(students[0], campus.groups["prof-b"], relayer.url)
  const r1b = await s1b.createEntity({ payload: sealReport("Synthetic: Professor B cancelled the exam without notice.", committee.publicKey), contentType: "application/json", attributes: { type: "report" }, expires: 86400 })
  link("report on Arkiv", explorer.entity(r1b.entityKey))
  check("the two reports have different owners (no link)", !same(r1.owner, r1b.owner), `${r1.owner.slice(0, 10)}… vs ${r1b.owner.slice(0, 10)}…`)

  beat("6. Four classmates report Professor A")
  const texts = [
    "Synthetic: Professor A mocked a student's question in front of the class.",
    "Synthetic: Professor A threatened to lower grades for students who complained.",
    "Synthetic: Professor A made comments about students' appearance.",
    "Synthetic: Professor A singled me out repeatedly during the lab.",
  ]
  for (let i = 1; i <= 4; i++) {
    const c = await studentClient(students[i], campus.groups["prof-a"], relayer.url)
    const r = await c.createEntity({ payload: sealReport(texts[i - 1], committee.publicKey), contentType: "application/json", attributes: { type: "report" }, expires: 86400 })
    link(`student ${i + 1}'s report`, explorer.entity(r.entityKey))
  }
  const view = await committeeView(campus.groups["prof-a"], relayer.address, committee.secret)
  check("committee sees 5 reports on Professor A", view.reports.length === 5, `${view.reports.length}`)
  check("from 5 distinct verified students", view.distinctStudents === 5, `${view.distinctStudents} distinct nullifiers`)
  check("every report's creator is the relayer", view.reports.every((r) => same(r.creator, relayer!.address)))
  check("every report has its own owner", new Set(view.reports.map((r) => r.owner.toLowerCase())).size === 5)
  check("the committee can read every report", view.reports.every((r) => r.text?.startsWith("Synthetic:")))
  check("the rejected duplicate is not counted", !view.reports.some((r) => r.text?.includes("second report")))

  beat("7. Months later, on a new device, Student 1 proves the report was theirs")
  const fresh = await studentClient(students[0], campus.groups["prof-a"], relayer.url) // new vault from the code alone
  const mine = await fresh.myEntities({ refresh: true })
  check("the recovery code finds the report", mine.some((m) => same(m.key, r1.entityKey)), `${mine.length} found`)
  const challenge = `campus-voice-${run}-hearing`
  const proof = await fresh.proveOwnership(r1.entityKey, { challenge, verifier: "complaints-committee" })
  const verdict = await verifyOwnershipProof(proof, { challenge, verifier: "complaints-committee", client: reader as any })
  check("the committee verifies the ownership proof", verdict.ok, verdict.ok ? "" : (verdict as any).reason)

  Object.assign(out, {
    groups: campus.groups,
    relayer: relayer.address,
    union: union.account.address,
    reportA: r1,
    reportB: r1b,
    rejection,
    committee: { distinctStudents: view.distinctStudents, reports: view.reports.map(({ text, ...r }) => r) },
  })
} catch (e) {
  failed++
  console.error((e as Error).stack)
} finally {
  await relayer?.close()
  out.verdict = failed ? "FAIL" : "PASS"
  try {
    writeFileSync(join(STATE, run, "result.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2))
  } catch {}
  console.log(`\n${failed ? `FAILED (${failed})` : "ALL PASS"} · run ${run} · relayer ${relayerWallet.account.address}`)
  process.exit(failed ? 1 : 0) // snarkjs keeps worker threads alive
}
