// The interface the client uses to reach derived keys. Two implementations:
//  - KeyVault (derive.ts): keys in this thread. Node, tests, relayer-side tools.
//  - WorkerVault (worker-vault.ts): keys inside a Web Worker; the page only ever gets addresses,
//    tags and Arkognito-shaped signatures back (D3). Default in browsers.
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import type { Address, Hex } from "viem"

/**
 * Which derived key. Inbox refs name a record someone else wrote for you (id = x(R) from its tag).
 * Records get a fresh random 15-byte id each (no counters, so nothing can be
 * reused after expiry or by a second device). A scope's id is a hash of its name.
 */
export type KeyRef = { kind: "record" | "scope" | "inbox"; id: Hex }

/** The envelope fields a record signature covers (see envelope.ts). */
export type EnvelopeBody = { app: string; ct: string; exp: number; enc: 0 | 1; data: string }

/** The fields an ownership proof signs (see proof.ts). */
export type ProofBody = { entityKey: Hex; challenge: string; verifier: string; expiresAt: number; chainId: number }

/**
 * A derived key as the page sees it: its address and exactly two signing operations, each of which
 * builds its own digest from structured fields. There is no "sign these bytes", so a compromised
 * page cannot make a one-time key sign anything that is not a Arkognito envelope or ownership proof.
 */
export type ArkognitoSigner = {
  address: Address
  signEnvelope(body: EnvelopeBody, attributes: AttributeInputs | Attributes | undefined): Promise<Hex>
  signProof(body: ProofBody): Promise<Hex>
}

export type NewKey = { ref: KeyRef; address: Address; tag: string }

export interface Vault {
  readonly app: string
  /** A fresh one-time key for a new record, with its encrypted tag. */
  newRecord(): Promise<NewKey>
  /** The key of a named scope, with a fresh encrypted tag. */
  scopeRecord(name: string): Promise<NewKey>
  /** Trial-decrypts record tags: for each, the key it names if it is ours, else null. */
  openTags(tags: string[]): Promise<(KeyRef | null)[]>
  addressOf(ref: KeyRef): Promise<Address>
  signer(ref: KeyRef): Promise<ArkognitoSigner>
  /** Encrypts a payload so only this vault can read it (AES-256-GCM under a per-record key). */
  encrypt(ref: KeyRef, data: Uint8Array): Promise<Uint8Array>
  decrypt(ref: KeyRef, data: Uint8Array): Promise<Uint8Array>
  /**
   * The address that asks the token issuer for rate-limit tokens. Derived from the root, stable per
   * (wallet, app), unrelated to the wallet address and to every record or scope key.
   */
  issuerIdentity(): Promise<Address>
  /** Signs a token-issuance request with the issuer identity (EIP-191 over `issuanceMessage`). */
  signIssuance(body: IssuanceBody): Promise<Hex>
  /** Your inbox address: share it so others can write records only you own and can read (inbox.ts). */
  inboxAddress(): Promise<string>
  /** Trial-opens tags as inbox tags: for each, its inbox key ref if it was written for you, else null. */
  openInbox(tags: string[]): Promise<(KeyRef | null)[]>
  /** Who must have signed this record's envelope: the owner, or for an inbox record the sender's derived key. */
  envelopeSignerOf(ref: KeyRef): Promise<Address>
}

/** The fields an issuance request signs (see issuance.ts). */
export type IssuanceBody = { app: string; epoch: number; blinded: string[]; ts: number }
