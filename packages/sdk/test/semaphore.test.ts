import assert from "node:assert/strict"
import { test } from "node:test"
import { KeyVault, canonicalAttributes, fromWire, padEnvelope, sealEnvelope, toBase64, toWire } from "arkognito"
import { Group } from "@semaphore-protocol/group"
import { createSemaphoreIdentity, createSemaphoreReader, assertMembership, membershipAttributes, membershipMessage, semaphoreScope, verifyMembership, MembershipInvalid, VerificationUnavailable, type SemaphoreGroup, type GroupSnapshot, type SemaphoreReader } from "arkognito/semaphore"

const group: SemaphoreGroup = { project: "veil-synthetic-test", admin: `0x${"11".repeat(20)}`, key: `0x${"22".repeat(32)}`, fromBlock: "10" }

test("Semaphore: recovered vault identity is stable, group-separated and never exported", async () => {
  const { vault, recoveryCode } = KeyVault.random(group.project)
  const restored = KeyVault.fromRecoveryCode(recoveryCode, group.project)
  assert.equal(await vault.membershipCommitment(group), await restored.membershipCommitment(group))
  assert.notEqual(await vault.membershipCommitment(group), await vault.membershipCommitment({ ...group, key: `0x${"33".repeat(32)}` }))
  assert.equal(Object.keys(vault).some(k => /secret|root|identity/i.test(k)), false)
})

test("Semaphore: real proof binds owner, payload, app, typed attributes, expiry, group and scope", { timeout: 90000 }, async () => {
  const vault = KeyVault.random(group.project).vault
  const signerKey = await vault.newRecord()
  const members = await Promise.all(Array.from({ length: 3 }, (_, i) => i === 0 ? vault.membershipCommitment(group) : Promise.resolve(createSemaphoreIdentity(crypto.getRandomValues(new Uint8Array(32))).commitment)))
  const snapshot: GroupSnapshot = { group, block: "12", root: new Group(members.map(BigInt)).root.toString(), members, rules: { version: 1, chainId: 7738577, depth: 3, minMembers: 3, maxRootAgeBlocks: 300, scope: { kind: "fixed", id: "synthetic-poll" } } }
  const scope = semaphoreScope(group, snapshot.rules, 12n)
  const attrs = { project: group.project, type: "synthetic", vtag: signerKey.tag }
  const unsigned = { v: 1, app: group.project, ct: "text/plain", exp: 3600, enc: 0 as const, data: toBase64(new TextEncoder().encode("Synthetic report")) }
  const proof = await vault.proveMembership({ snapshot, scope, message: membershipMessage(group, "12", scope, signerKey.address, unsigned, attrs) })
  const membership = { group: group.key, rootBlock: "12", proof }
  const attributes = { ...attrs, ...membershipAttributes(membership) }
  const sealed = await sealEnvelope({ signer: await vault.signer(signerKey.ref), app: group.project, payload: new TextEncoder().encode("Synthetic report"), contentType: "text/plain", attributes, expSeconds: 3600 })
  const envelope = { ...sealed.envelope, membership }
  const input = { group, snapshot, membership, owner: signerKey.address, envelope, attributes, atBlock: 13n }
  await verifyMembership(input)
  await verifyMembership({ ...input, attributes: fromWire(toWire(attributes)) })
  const bad: Parameters<typeof verifyMembership>[0][] = [
    { ...input, owner: group.admin },
    { ...input, envelope: { ...envelope, data: toBase64(new TextEncoder().encode("Edited")) } },
    { ...input, envelope: { ...envelope, exp: 86400 } },
    { ...input, envelope: { ...envelope, app: "other-app" } },
    { ...input, attributes: { ...attributes, type: "changed" } },
    { ...input, attributes: { ...attributes, zknullifier: "1" } },
    { ...input, membership: { ...membership, proof: { ...proof, points: Array(8).fill("0") as typeof proof.points } } },
    { ...input, snapshot: { ...snapshot, members: [...members].reverse() } },
    { ...input, atBlock: 400n },
    { ...input, group: { ...group, key: `0x${"33".repeat(32)}` } },
  ]
  for (const candidate of bad) await assert.rejects(verifyMembership(candidate), MembershipInvalid)
  const outsider = KeyVault.random(group.project).vault
  await assert.rejects(outsider.proveMembership({ snapshot, scope, message: proof.message }), /not in/)
  assert.throws(() => createSemaphoreIdentity(new Uint8Array(3)), /32-byte/)
  assert.equal(canonicalAttributes(attributes), canonicalAttributes(fromWire(toWire(attributes))))
  const { pad: _pad, ...unpadded } = envelope
  assert.ok(new TextEncoder().encode(padEnvelope(unpadded)).length <= 16384)
})

test("Semaphore scopes: fixed polls and block windows are separated by group and window", () => {
  const rules = { version: 1 as const, chainId: 7738577, depth: 3, minMembers: 3, maxRootAgeBlocks: 300, scope: { kind: "window" as const, blocks: 10 } }
  assert.equal(semaphoreScope(group, rules, 10n), semaphoreScope(group, rules, 19n))
  assert.notEqual(semaphoreScope(group, rules, 19n), semaphoreScope(group, rules, 20n))
  assert.notEqual(semaphoreScope(group, rules, 19n), semaphoreScope({ ...group, key: `0x${"33".repeat(32)}` }, rules, 19n))
})

test("Semaphore reader: RPC outages are unavailable, never an empty feed; metadata is bounded", async () => {
  const reader = { getBlockNumber: async () => { throw Error("Injected provider outage") } } as unknown as SemaphoreReader
  await assert.rejects(createSemaphoreReader(reader, group, { trustedRelayers: [group.admin] }).readPosts(), VerificationUnavailable)
  assert.throws(() => createSemaphoreReader(reader, group, { trustedRelayers: [] }), /trusted relayers/)
  assert.throws(() => createSemaphoreReader(reader, group, { trustedRelayers: [group.admin], maxPages: 0 }), /budgets/)
  for (const rootBlock of ["not-a-block", "18446744073709551616", null]) assert.throws(() => assertMembership({ group: group.key, rootBlock }), MembershipInvalid)
})
