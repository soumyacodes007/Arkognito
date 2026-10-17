// Optional membership layer. No Node APIs: usable in a browser and in the key worker.
import { sha256 } from "@noble/hashes/sha2.js"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateProof, verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof"
import { u64 } from "@arkiv-network/sdk/attr"
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import { bytesToHex, isAddress, type Address, type Hex } from "viem"
import { canonicalAttributes } from "./attrs.ts"
import { TIRAMISU_CHAIN_ID } from "./constants.ts"
import type { Envelope } from "./envelope.ts"

export type { SemaphoreProof }
export type SnarkArtifacts = Parameters<typeof generateProof>[5]
export type SemaphoreScope = { kind: "fixed"; id: string } | { kind: "window"; blocks: number }
export type SemaphoreGroup = { project: string; admin: Address; key: Hex; fromBlock: string }
export type SemaphoreRules = { version: 1; chainId: number; depth: number; minMembers: number; maxRootAgeBlocks: number; scope: SemaphoreScope }
export type GroupSnapshot = { group: SemaphoreGroup; rules: SemaphoreRules; block: string; members: string[]; root: string }
export type Membership = { group: Hex; rootBlock: string; proof: SemaphoreProof }
export type MembershipWitness = { snapshot: GroupSnapshot; scope: string; message: string; snarkArtifacts?: SnarkArtifacts }
export type SemaphoreOptions = { group: SemaphoreGroup; snarkArtifacts?: SnarkArtifacts }
export type MembershipVault = {
  membershipCommitment(group: SemaphoreGroup): Promise<string>
  proveMembership(witness: MembershipWitness): Promise<SemaphoreProof>
}

export class MembershipInvalid extends Error { override name = "MembershipInvalid" }
export class VerificationUnavailable extends Error { override name = "VerificationUnavailable" }
export const ZK_ATTRIBUTES = ["zkgroup", "zkscope", "zknullifier", "zkroot", "zkblock"] as const
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)
export const hashToDecimal = (v: unknown) => BigInt(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(v))))).toString()

export function assertGroup(group: SemaphoreGroup): void {
  if (!group || typeof group.project !== "string" || !group.project || new TextEncoder().encode(group.project).length > 128 || !isAddress(group.admin) || !/^0x[0-9a-fA-F]{64}$/.test(group.key) || !decimal(group.fromBlock)) throw new MembershipInvalid("Invalid group descriptor")
}
export function membershipDomain(group: SemaphoreGroup): string {
  assertGroup(group)
  return JSON.stringify(["veil-membership-v1", TIRAMISU_CHAIN_ID, group.project, group.admin.toLowerCase(), group.key.toLowerCase()])
}
export function assertRules(r: SemaphoreRules): void {
  if (!r || r.version !== 1 || r.chainId !== TIRAMISU_CHAIN_ID || !Number.isInteger(r.depth) || r.depth < 1 || r.depth > 32 || !Number.isInteger(r.minMembers) || r.minMembers < 3 || r.minMembers > 2 ** r.depth || !Number.isSafeInteger(r.maxRootAgeBlocks) || r.maxRootAgeBlocks < 1) throw new MembershipInvalid("Invalid Semaphore group rules")
  if (!r.scope || (r.scope.kind === "fixed" ? typeof r.scope.id !== "string" || !r.scope.id || r.scope.id.length > 128 : r.scope.kind !== "window" || !Number.isSafeInteger(r.scope.blocks) || r.scope.blocks < 1)) throw new MembershipInvalid("Invalid group scope policy")
}
export function semaphoreScope(group: SemaphoreGroup, rules: SemaphoreRules, block: bigint): string {
  assertRules(rules)
  if (block < 0n) throw new MembershipInvalid("Invalid scope block")
  return hashToDecimal([membershipDomain(group), rules.scope.kind === "fixed" ? ["fixed", rules.scope.id] : ["window", (block / BigInt(rules.scope.blocks)).toString()]])
}
export function assertProof(proof: unknown): asserts proof is SemaphoreProof {
  const p = proof as SemaphoreProof
  if (!p || !Number.isInteger(p.merkleTreeDepth) || p.merkleTreeDepth < 1 || p.merkleTreeDepth > 32 || ![p.merkleTreeRoot, p.nullifier, p.scope, p.message].every(decimal) || !Array.isArray(p.points) || p.points.length !== 8 || !p.points.every(decimal)) throw new MembershipInvalid("Invalid Semaphore proof schema")
}
export function assertMembership(value: unknown): asserts value is Membership {
  const m = value as Membership
  if (!m || typeof m.group !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.group) || !decimal(m.rootBlock) || BigInt(m.rootBlock) > 18446744073709551615n) throw new MembershipInvalid("Invalid membership metadata")
  assertProof(m.proof)
}
export function assertMembers(members: readonly string[], rules: SemaphoreRules, allowUnready = false): void {
  assertRules(rules)
  if ((!allowUnready && members.length < rules.minMembers) || members.length > 2 ** rules.depth || members.some(m => !decimal(m) || BigInt(m) <= 0n || BigInt(m) >= field) || new Set(members).size !== members.length) throw new MembershipInvalid("Invalid or insufficient group members")
}

/** Binds authorization to ciphertext/plaintext bytes, intended owner, typed app attributes and expiry.
 * The five proof projections are checked separately to avoid a circular nullifier/message dependency.
 */
export function membershipMessage(group: SemaphoreGroup, rootBlock: string, scope: string, owner: Address, envelope: Pick<Envelope, "v" | "app" | "ct" | "exp" | "enc" | "data">, attributes: AttributeInputs | Attributes): string {
  if (!decimal(rootBlock) || !decimal(scope) || !isAddress(owner)) throw new MembershipInvalid("Invalid membership message identifiers")
  const base = Object.fromEntries(Object.entries(attributes).filter(([k]) => !(ZK_ATTRIBUTES as readonly string[]).includes(k)))
  return hashToDecimal([membershipDomain(group), rootBlock, scope, owner.toLowerCase(), envelope.v, envelope.app, envelope.ct, envelope.exp, envelope.enc, envelope.data, canonicalAttributes(base)])
}
export function membershipAttributes(m: Membership): AttributeInputs {
  assertProof(m.proof)
  return { zkgroup: m.group, zkscope: m.proof.scope, zknullifier: m.proof.nullifier, zkroot: m.proof.merkleTreeRoot, zkblock: u64(BigInt(m.rootBlock)) }
}
export function createSemaphoreIdentity(secret: Uint8Array) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new MembershipInvalid("Semaphore requires a high-entropy 32-byte secret")
  const identity = new Identity(secret.slice())
  return {
    commitment: identity.commitment.toString(),
    async prove(w: MembershipWitness): Promise<SemaphoreProof> {
      assertGroup(w.snapshot.group)
      assertMembers(w.snapshot.members, w.snapshot.rules)
      const tree = new Group(w.snapshot.members.map(BigInt))
      if (tree.root.toString() !== w.snapshot.root || !w.snapshot.members.includes(identity.commitment.toString())) throw new MembershipInvalid("Identity is not in the selected group snapshot")
      return generateProof(identity, tree, w.message, w.scope, w.snapshot.rules.depth, w.snarkArtifacts)
    },
  }
}

export async function verifyMembership(args: { group: SemaphoreGroup; snapshot: GroupSnapshot; membership: Membership; owner: Address; envelope: Envelope; attributes: AttributeInputs | Attributes; atBlock: bigint }): Promise<void> {
  const { group, snapshot, membership: m, owner, envelope, attributes, atBlock } = args
  assertGroup(group); assertMembership(m); assertMembers(snapshot.members, snapshot.rules)
  if (membershipDomain(snapshot.group) !== membershipDomain(group) || m.group.toLowerCase() !== group.key.toLowerCase() || snapshot.block !== m.rootBlock || !decimal(m.rootBlock)) throw new MembershipInvalid("Group or snapshot mismatch")
  const rootBlock = BigInt(m.rootBlock)
  if (rootBlock < BigInt(group.fromBlock) || rootBlock > atBlock || atBlock - rootBlock > BigInt(snapshot.rules.maxRootAgeBlocks)) throw new MembershipInvalid("Membership root is future or too old")
  const scope = semaphoreScope(group, snapshot.rules, atBlock)
  const projections = membershipAttributes(m)
  for (const [k, v] of Object.entries(projections)) {
    if (attributes[k] === undefined || canonicalAttributes({ [k]: attributes[k] } as AttributeInputs) !== canonicalAttributes({ [k]: v })) throw new MembershipInvalid(`Proof attribute mismatch: ${k}`)
  }
  if (m.proof.scope !== scope || m.proof.merkleTreeDepth !== snapshot.rules.depth || new Group(snapshot.members.map(BigInt)).root.toString() !== m.proof.merkleTreeRoot || snapshot.root !== m.proof.merkleTreeRoot) throw new MembershipInvalid("Historical root or scope mismatch")
  if (m.proof.message !== membershipMessage(group, m.rootBlock, scope, owner, envelope, attributes)) throw new MembershipInvalid("Membership content hash mismatch")
  try { if (await verifyProof(m.proof)) return } catch { /* Malformed curve points are invalid, not a provider outage. */ }
  throw new MembershipInvalid("Invalid Semaphore proof")
}

export { createSemaphoreReader, createSemaphoreGroup, addSemaphoreMembers, SemaphoreWriteQueue } from "./semaphore-arkiv.ts"
export type { SemaphoreReader, SemaphoreWriter, WriteCoordinator, Publication, MembershipReadResult } from "./semaphore-arkiv.ts"
