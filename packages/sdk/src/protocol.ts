// Relayer HTTP API, shared by the SDK client and the relayer (spec/SPEC.md documents it).
import type { Address, Hex } from "viem"
import type { WireAttributes } from "./attrs.ts"

export type TokenRedemption = {
  /** Day number (UTC days since epoch) of the issuer key that signed the token. */
  epoch: number
  /** 32-byte random nonce, hex. Its sha256 becomes the `arkognito.spent` tokenId. */
  nonce: Hex
  /** RSA blind signature over the prepared message, base64. */
  signature: string
}

export type SubmitRequest = {
  app: string
  /** The one-time owner S. */
  owner: Address
  /** Sealed, padded envelope text. */
  envelope: string
  attributes: WireAttributes
  expSeconds: number
  token?: TokenRedemption
  /**
   * Smallest batch this record may be written in (B2). The relayer holds it until a batch of at least
   * this many records forms, up to `maxHoldMs`, then fails it rather than write it in a smaller one.
   */
  minAnonymity?: number
  maxHoldMs?: number
  /**
   * An inbox record (inbox.ts): written for someone else, so the envelope is signed by a key derived
   * for the recipient instead of by `owner`. The relayer then checks only that the signature is valid.
   */
  inbox?: boolean
}

export type SubmitResponse = { id: string }

export type RecordState = "queued" | "written" | "failed"

export type StatusResponse = {
  id: string
  state: RecordState
  entityKey?: Hex
  txHash?: Hex
  /** How many records shared the batch: the anonymity set this record landed in (B2). */
  batchSize?: number
  /**
   * How many of those were cover records the relayer added (B5). Outsiders cannot tell them apart
   * from real ones; the relayer tells you so you know how many real records you were mixed with.
   */
  cover?: number
  /** Block the batch landed in. */
  block?: string
  /** While queued: how many requests are ahead of this one. Lets clients tell a long queue from censorship (R3). */
  position?: number
  error?: string
}

export type InfoResponse = {
  address: Address
  version: string
  chainId: number
  minBatch: number
  maxWaitMs: number
  minIntervalBlocks: number
  tokensRequired: boolean
  /** Issuer wallet whose `arkognito.issuerKey` entities this relayer accepts, when tokens are required. */
  issuer?: Address
  /** Token issuance endpoint base URL, when this service also runs the issuer. */
  issuerUrl?: string
  /** Largest minAnonymity this relayer accepts, and the longest it will hold a record for it. */
  maxMinAnonymity: number
  maxHoldMs: number
  /** Oblivious HTTP gateway key (X25519, hex), when the relayer accepts requests through an OHTTP relay. Also published in its heartbeat. */
  ohttpKey?: string
  /** Batches smaller than this are filled with cover records (B5), for encrypted records. */
  coverMinBatch?: number
}

export type IssueRequest = {
  app: string
  epoch: number
  /** Wallet asking for tokens; quota is counted against it. */
  wallet: Address
  /** EIP-191 signature by `wallet` over the issuance message, proving control of it. */
  walletSignature: Hex
  /** Blinded messages, base64. One token per element. */
  blinded: string[]
  /** One-time attestation code, when the issuer requires one (T5). */
  attestation?: string
}

export type IssueResponse = { blindSignatures: string[]; remaining: number }

export const API_VERSION = "arkognito-relayer/1"
