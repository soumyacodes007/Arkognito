// Ownership proofs (D4): reveal to one verifier, for one challenge, until one deadline, that one
// record's owner is you. Nothing else about your other records is revealed.
import { type Address, type Hex, recoverTypedDataAddress } from "viem"
import { TIRAMISU_CHAIN_ID } from "./constants.ts"
import type { ArkivReader } from "./reader.ts"
import type { ProofBody, ArkognitoSigner } from "./vault.ts"

export type OwnershipProof = {
  entityKey: Hex
  owner: Address
  challenge: string
  verifier: string
  expiresAt: number
  chainId: number
  signature: Hex
}

export function proofTypedData(p: ProofBody) {
  return {
    domain: { name: "arkognito", version: "1", chainId: p.chainId },
    types: {
      OwnershipProof: [
        { name: "entityKey", type: "bytes32" },
        { name: "challenge", type: "string" },
        { name: "verifier", type: "string" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "OwnershipProof",
    message: { entityKey: p.entityKey, challenge: p.challenge, verifier: p.verifier, expiresAt: BigInt(p.expiresAt) },
  } as const
}

export async function signOwnershipProof(
  signer: ArkognitoSigner,
  args: { entityKey: Hex; challenge: string; verifier: string; ttlSeconds?: number; chainId?: number },
): Promise<OwnershipProof> {
  const body = {
    entityKey: args.entityKey,
    challenge: args.challenge,
    verifier: args.verifier,
    expiresAt: Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? 300),
    chainId: args.chainId ?? TIRAMISU_CHAIN_ID,
  }
  const signature = await signer.signProof(body)
  return { ...body, owner: signer.address, signature }
}

export type ProofCheck = { ok: true } | { ok: false; reason: string }

/** Verifier side. Checks challenge, audience, deadline, signature, and that the chain still says this owner. */
export async function verifyOwnershipProof(
  proof: OwnershipProof,
  expect: { challenge: string; verifier: string; client: ArkivReader; now?: number },
): Promise<ProofCheck> {
  const now = expect.now ?? Math.floor(Date.now() / 1000)
  if (proof.challenge !== expect.challenge) return { ok: false, reason: "challenge does not match" }
  if (proof.verifier !== expect.verifier) return { ok: false, reason: "proof was made for a different verifier" }
  if (proof.expiresAt < now) return { ok: false, reason: "proof has expired" }
  let signer: Address
  try {
    signer = await recoverTypedDataAddress({ ...proofTypedData(proof), signature: proof.signature })
  } catch {
    return { ok: false, reason: "signature is malformed" }
  }
  if (signer.toLowerCase() !== proof.owner.toLowerCase()) return { ok: false, reason: "signature is not from the claimed owner" }
  let onChainOwner: string | undefined
  try {
    onChainOwner = (await expect.client.getEntity(proof.entityKey)).owner
  } catch {
    return { ok: false, reason: "record not found (deleted or expired)" }
  }
  if (onChainOwner?.toLowerCase() !== proof.owner.toLowerCase()) return { ok: false, reason: "record is owned by someone else" }
  return { ok: true }
}
