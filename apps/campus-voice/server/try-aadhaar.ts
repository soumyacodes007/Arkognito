// End-to-end check of the Anon Aadhaar join in Node (the browser does the same proving step).
//   npx tsx --conditions=arkognito-source apps/campus-voice/server/try-aadhaar.ts   (~3 minutes)
import { ArtifactsOrigin, artifactUrls, generateArgs, init, prove } from "@anon-aadhaar/core"
import { NULLIFIER_SEED, joinSignal, makeTestCard, testCertificate, verifyJoin } from "./aadhaar"

let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}

// Synthetic commitments stand in for a student's membership tokens.
const commitments = { "prof-a": "123456789", "prof-b": "987654321" }
const t0 = Date.now()
const card = await makeTestCard()
check("a fresh test card is generated", card.length > 1000, `${card.length} digits`)
const args = await generateArgs({ qrData: card, certificateFile: await testCertificate(), nullifierSeed: NULLIFIER_SEED, fieldsToRevealArray: ["revealAgeAbove18"], signal: joinSignal(commitments) })
await init({ wasmURL: artifactUrls.v2.wasm, zkeyURL: artifactUrls.v2.zkey, vkeyURL: artifactUrls.v2.vk, artifactsOrigin: ArtifactsOrigin.server })
const pcd = await prove(args, (s) => console.log(`   ${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`))
check("over 18 is revealed, nothing else", pcd.proof.ageAbove18 === "1" && pcd.proof.pincode === "0" && pcd.claim.gender === null && pcd.claim.state === null)

const used = new Set<string>()
const first = await verifyJoin(pcd, commitments, used)
check("the union verifies the proof", first.ok, first.ok ? `nullifier ${first.nullifier.slice(0, 12)}…` : first.reason)
if (first.ok) used.add(first.nullifier)
const again = await verifyJoin(pcd, commitments, used)
check("the same card cannot join twice", !again.ok && /already joined/.test(again.reason), again.ok ? "" : again.reason)
const other = await verifyJoin(pcd, { ...commitments, "prof-a": "111" }, new Set())
check("the proof cannot be reused for other membership tokens", !other.ok && /bound/.test(other.reason), other.ok ? "" : other.reason)
const second = await makeTestCard()
check("each test card is different", second !== card)
console.log(`\n${failed ? `FAILED (${failed})` : "ALL PASS"} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
process.exit(failed ? 1 : 0)
