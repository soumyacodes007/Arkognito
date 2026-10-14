// Key derivation (PRD §5 "Key derivation", edge cases K1–K8), version 2.
//
//   signature = EIP-712 sign { purpose: "arkognito key v1", app, chainId }
//   root      = HKDF-SHA256(signature, info = "arkognito/root/v1/" + app)
//   k(ref)    = HKDF(root, info = ref.kind + "/" + hex(ref.id), 48) reduced to a secp256k1 key
//                 record: id = 15 random bytes per record
//                 scope:  id = sha256("arkognito/scope/" + name)[0..15]
//   tag(ref)  = AES-256-GCM(key = HKDF(root, "arkognito/tag/v1"), iv = 12 random bytes,
//                           plaintext = kind byte (0 record, 1 scope) || id, aad = "arkognito/tag/v1|" + app)
//
// Every record carries its tag as the `vtag` attribute. Only the holder of the root can open a tag,
// so the user finds their records by downloading the app's tags and trial-decrypting them. No
// counters: nothing to reuse after records expire, nothing for two devices to collide on, and no
// gap limit to fall off.
//
// The root never leaves a KeyVault: callers get addresses, tags and Arkognito-shaped signatures only.
import { gcm } from "@noble/ciphers/aes.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import { bytesToHex, hexToBytes, type Account, type Address, type Hex, type PublicClient } from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { TIRAMISU_CHAIN_ID } from "./constants.ts"
import { envelopeDigest } from "./envelope.ts"
import {
  type InboxSecrets,
  formatInboxAddress,
  fromB64url as inboxB64,
  inboxOwnerKey,
  inboxSecrets,
  openData,
  pubOf,
  sealData,
  sharedFromTagX,
} from "./inbox.ts"
import { issuanceMessage } from "./issuance.ts"
import { type PasskeyOptions, createPasskeySecret, getPasskeySecret } from "./passkey.ts"
import { proofTypedData } from "./proof.ts"
import type { EnvelopeBody, IssuanceBody, KeyRef, NewKey, ProofBody, Vault, ArkognitoSigner } from "./vault.ts"

/**
 * Any viem wallet client, including the Arkiv SDK's own `createWalletClient`. Its declared type
 * leaves out viem's signing actions although they exist at runtime (see arkiv/friction.md), so only
 * the account is required here and the signing methods are checked when used.
 */
export type SigningWallet = { account?: Account | { address: Address } | undefined }

type Signer = {
  account?: { address: Address }
  signTypedData: (args: unknown) => Promise<Hex>
  signMessage: (args: unknown) => Promise<Hex>
}

/** The wallet's signing methods, or a clear error when it cannot sign. */
export function asSigner(wallet: SigningWallet): Signer & { account: { address: Address } } {
  const w = wallet as Partial<Signer>
  if (!w.account) throw new Error("wallet has no account")
  if (typeof w.signTypedData !== "function" || typeof w.signMessage !== "function") {
    throw new Error("wallet cannot sign messages; pass a viem or Arkiv SDK wallet client")
  }
  return w as Signer & { account: { address: Address } }
}

export const DERIVATION_PURPOSE = "arkognito key v1"

/** The EIP-712 message a wallet signs once per app. Purpose, app and chain sit in what the wallet shows (K3, K6). */
export function derivationTypedData(app: string, chainId: number = TIRAMISU_CHAIN_ID) {
  return {
    domain: { name: "arkognito", version: "1", chainId },
    types: {
      ArkognitoKey: [
        { name: "purpose", type: "string" },
        { name: "app", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
    },
    primaryType: "ArkognitoKey",
    message: { purpose: DERIVATION_PURPOSE, app, chainId: BigInt(chainId) },
  } as const
}

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const enc = new TextEncoder()

/** 48 bytes of HKDF output reduced mod n-1, plus 1: a valid key with negligible bias. */
function childPrivateKey(root: Uint8Array, info: string): Hex {
  const okm = hkdf(sha256, root, undefined, enc.encode(info), 48)
  const k = (BigInt(bytesToHex(okm)) % (N - 1n)) + 1n
  return `0x${k.toString(16).padStart(64, "0")}`
}

export class NonDeterministicWalletError extends Error {
  constructor() {
    super(
      "This wallet produced two different signatures for the same message, so it cannot re-derive " +
        "your Arkognito keys next time. Use random-root mode with a recovery code instead (K1).",
    )
  }
}

export class SmartContractWalletError extends Error {
  constructor(address: Address) {
    super(`${address} is a smart contract wallet. Arkognito v1 needs an EOA that signs with ECDSA (K2).`)
  }
}

/** Where the K1 check remembers a wallet it has already verified. Holds a 16-byte fingerprint, never the signature. */
export type DeterminismStore = { get(key: string): string | null | undefined; set(key: string, value: string): void }

/**
 * When to check that the wallet signs deterministically (K1):
 * - "first-use" (default): sign twice the first time a wallet is seen for this app on this device,
 *   remember a fingerprint of the signature, and sign once afterwards, comparing with the fingerprint.
 * - "always" or true: sign twice every time.
 * - "never" or false: sign once and trust the wallet.
 */
export type DeterminismMode = "first-use" | "always" | "never" | boolean

export type DerivationOptions = {
  publicClient?: Pick<PublicClient, "getCode">
  chainId?: number
  verifyDeterminism?: DeterminismMode
  /** Where "first-use" keeps its fingerprints. Default: localStorage when there is one, else this process's memory. */
  determinismStore?: DeterminismStore
}

const memoryChecks = new Map<string, string>()

/** localStorage when the environment has a working one, else a map that lives as long as the process. */
export function defaultDeterminismStore(): DeterminismStore {
  const mem: DeterminismStore = { get: (k) => memoryChecks.get(k), set: (k, v) => void memoryChecks.set(k, v) }
  return {
    get(k) {
      try {
        const v = globalThis.localStorage?.getItem(k)
        if (v != null) return v
      } catch {
        // storage blocked
      }
      return mem.get(k)
    },
    set(k, v) {
      mem.set(k, v)
      try {
        globalThis.localStorage?.setItem(k, v)
      } catch {
        // storage blocked: memory only
      }
    },
  }
}

/** A fingerprint of a derivation signature: enough to notice a different signature, useless for deriving keys. */
function signatureFingerprint(sig: Hex): string {
  return bytesToHex(hkdf(sha256, hexToBytes(sig), undefined, enc.encode("arkognito/wallet-check/v1"), 16))
}

/**
 * Holds the root key for one app and hands out derived addresses and signatures.
 * The root is in a private field: nothing outside this class can read it.
 */
export class KeyVault implements Vault {
  readonly #root: Uint8Array
  readonly app: string
  readonly mode: "signature" | "random" | "passkey"
  readonly #cache = new Map<string, PrivateKeyAccount>()
  readonly #inbox = new Map<string, InboxSecrets>()

  private constructor(root: Uint8Array, app: string, mode: "signature" | "random" | "passkey") {
    this.#root = root
    this.app = app
    this.mode = mode
  }

  /** Root from a wallet signature. Refuses wallets that do not sign deterministically (K1). */
  static async fromWallet(wallet: SigningWallet, app: string, opts: DerivationOptions = {}): Promise<KeyVault> {
    return KeyVault.fromSignature(await KeyVault.signDerivation(wallet, app, opts), app)
  }

  /**
   * Asks the wallet for the derivation signature, after refusing smart-contract wallets (K2), and
   * refuses wallets whose signatures are not deterministic (K1). By default the wallet signs twice
   * only the first time this device sees it for this app; later connects sign once and compare
   * against a stored fingerprint.
   */
  static async signDerivation(wallet: SigningWallet, app: string, opts: DerivationOptions = {}): Promise<Hex> {
    const signer = asSigner(wallet)
    const account = signer.account
    if (typeof opts.publicClient?.getCode === "function") {
      const code = await opts.publicClient.getCode({ address: account.address })
      if (code && code !== "0x") throw new SmartContractWalletError(account.address)
    }
    const chainId = opts.chainId ?? TIRAMISU_CHAIN_ID
    const typed = derivationTypedData(app, chainId)
    const sign = () => signer.signTypedData({ account, ...typed })
    const mode = opts.verifyDeterminism ?? "first-use"
    const first = await sign()
    if (mode === false || mode === "never") return first
    if (mode === true || mode === "always") {
      const second = await sign()
      if (first.toLowerCase() !== second.toLowerCase()) throw new NonDeterministicWalletError()
      return first
    }
    const store = opts.determinismStore ?? defaultDeterminismStore()
    const slot = `arkognito:wallet-check:${chainId}:${app}:${account.address.toLowerCase()}`
    const fp = signatureFingerprint(first)
    const known = store.get(slot)
    if (known) {
      if (known !== fp) throw new NonDeterministicWalletError()
      return first
    }
    const second = await sign()
    if (first.toLowerCase() !== second.toLowerCase()) throw new NonDeterministicWalletError()
    store.set(slot, fp)
    return first
  }

  /** Root from a derivation signature the caller already holds. */
  static fromSignature(signature: Hex, app: string): KeyVault {
    const root = hkdf(sha256, hexToBytes(signature), undefined, enc.encode(`arkognito/root/v1/${app}`), 32)
    return new KeyVault(root, app, "signature")
  }

  /** Random root (K1 fallback). Returns the vault and a recovery code the user must keep. */
  static random(app: string): { vault: KeyVault; recoveryCode: string } {
    const root = crypto.getRandomValues(new Uint8Array(32))
    return { vault: new KeyVault(root, app, "random"), recoveryCode: `arkognito1-${bytesToHex(root).slice(2)}` }
  }

  /** Root from a passkey's PRF secret for this app (see passkey.ts). */
  static fromPasskeySecret(secret: Uint8Array, app: string): KeyVault {
    return new KeyVault(passkeyRoot(secret, app), app, "passkey")
  }

  /** The recovery code for a passkey root: restores the same keys with `fromRecoveryCode` if the passkey is lost. */
  static passkeyRecoveryCode(secret: Uint8Array, app: string): string {
    return `arkognito1-${bytesToHex(passkeyRoot(secret, app)).slice(2)}`
  }

  /** Signs in with an existing passkey: one biometric or PIN prompt, no wallet. */
  static async fromPasskey(app: string, opts: PasskeyOptions = {}): Promise<KeyVault> {
    return KeyVault.fromPasskeySecret((await getPasskeySecret(app, opts)).secret, app)
  }

  /** Creates a passkey and a root from it. Show the recovery code to the user once; it is the only backup. */
  static async createPasskey(app: string, opts: PasskeyOptions = {}): Promise<{ vault: KeyVault; recoveryCode: string; credentialId: string }> {
    const { secret, credentialId } = await createPasskeySecret(app, opts)
    return { vault: KeyVault.fromPasskeySecret(secret, app), recoveryCode: KeyVault.passkeyRecoveryCode(secret, app), credentialId }
  }

  static fromRecoveryCode(code: string, app: string): KeyVault {
    const m = code.trim().match(/^arkognito1-([0-9a-f]{64})$/i)
    if (!m) throw new Error("not a Arkognito recovery code")
    return new KeyVault(hexToBytes(`0x${m[1]}`), app, "random")
  }

  #account(ref: KeyRef): PrivateKeyAccount {
    checkRef(ref)
    const info = `${ref.kind}/${ref.id.toLowerCase()}`
    if (ref.kind === "inbox") {
      let acct = this.#cache.get(info)
      if (!acct) {
        acct = privateKeyToAccount(inboxOwnerKey(this.#inboxKey("spend"), this.#inboxSecrets(ref)))
        this.#cache.set(info, acct)
      }
      return acct
    }
    let acct = this.#cache.get(info)
    if (!acct) {
      acct = privateKeyToAccount(childPrivateKey(this.#root, info))
      this.#cache.set(info, acct)
    }
    return acct
  }

  #tagKey(): Uint8Array {
    return hkdf(sha256, this.#root, undefined, enc.encode("arkognito/tag/v1"), 32)
  }

  #dataKey(ref: KeyRef): Uint8Array {
    checkRef(ref)
    if (ref.kind === "inbox") return this.#inboxSecrets(ref).dataKey
    return hkdf(sha256, this.#root, undefined, enc.encode(`arkognito/data/v1/${ref.kind}/${ref.id.toLowerCase()}`), 32)
  }

  #seal(ref: KeyRef): string {
    const plain = new Uint8Array(16)
    plain[0] = ref.kind === "record" ? 0 : 1
    plain.set(hexToBytes(ref.id), 1)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = gcm(this.#tagKey(), iv, enc.encode(`arkognito/tag/v1|${this.app}`)).encrypt(plain)
    return toB64url(concat(iv, ct))
  }

  #open(tag: string, key: Uint8Array): KeyRef | null {
    try {
      const raw = fromB64url(tag)
      if (raw.length !== TAG_BYTES) return null
      const plain = gcm(key, raw.subarray(0, 12), enc.encode(`arkognito/tag/v1|${this.app}`)).decrypt(raw.subarray(12))
      if (plain[0] > 1) return null
      return { kind: plain[0] === 0 ? "record" : "scope", id: bytesToHex(plain.subarray(1)) }
    } catch {
      return null
    }
  }

  async newRecord(): Promise<NewKey> {
    const ref: KeyRef = { kind: "record", id: bytesToHex(crypto.getRandomValues(new Uint8Array(15))) }
    return { ref, address: this.#account(ref).address, tag: this.#seal(ref) }
  }

  async scopeRecord(name: string): Promise<NewKey> {
    const ref = scopeRef(name)
    return { ref, address: this.#account(ref).address, tag: this.#seal(ref) }
  }

  async openTags(tags: string[]): Promise<(KeyRef | null)[]> {
    const key = this.#tagKey()
    return tags.map((t) => (typeof t === "string" ? this.#open(t, key) : null))
  }

  async addressOf(ref: KeyRef): Promise<Address> {
    return this.#account(ref).address
  }

  async signer(ref: KeyRef): Promise<ArkognitoSigner> {
    const acct = this.#account(ref)
    return {
      address: acct.address,
      signEnvelope: (body: EnvelopeBody, attributes: AttributeInputs | Attributes | undefined) =>
        acct.signMessage({ message: { raw: envelopeDigest(body, attributes) } }),
      signProof: (body: ProofBody) => acct.signTypedData(proofTypedData(body)),
    }
  }

  #issuer(): PrivateKeyAccount {
    // Its own HKDF label, outside the "record/" and "scope/" namespaces, so no KeyRef reaches it.
    const info = "identity/issuer/v1"
    let acct = this.#cache.get(info)
    if (!acct) {
      acct = privateKeyToAccount(childPrivateKey(this.#root, info))
      this.#cache.set(info, acct)
    }
    return acct
  }

  async issuerIdentity(): Promise<Address> {
    return this.#issuer().address
  }

  async signIssuance(body: IssuanceBody): Promise<Hex> {
    if (body.app !== this.app) throw new Error(`this vault is for ${this.app}, not ${body.app}`)
    return this.#issuer().signMessage({ message: issuanceMessage(body, body.ts) })
  }

  async encrypt(ref: KeyRef, data: Uint8Array): Promise<Uint8Array> {
    return sealData(this.#dataKey(ref), data)
  }

  async decrypt(ref: KeyRef, data: Uint8Array): Promise<Uint8Array> {
    return openData(this.#dataKey(ref), data)
  }

  // ---- inbox: records others write for you (inbox.ts) -----------------------------------------

  /** Inbox keys sit under their own labels, outside the record/ and scope/ namespaces. */
  #inboxKey(which: "spend" | "view"): bigint {
    return BigInt(childPrivateKey(this.#root, `identity/inbox-${which}/v1`))
  }

  #inboxSecrets(ref: KeyRef): InboxSecrets {
    const id = ref.id.toLowerCase()
    let s = this.#inbox.get(id)
    if (!s) {
      const shared = sharedFromTagX(hexToBytes(ref.id), this.#inboxKey("view"))
      if (!shared) throw new Error("bad key ref")
      s = inboxSecrets(shared, this.app)
      this.#inbox.set(id, s)
    }
    return s
  }

  async inboxAddress(): Promise<string> {
    return formatInboxAddress(pubOf(this.#inboxKey("spend")), pubOf(this.#inboxKey("view")))
  }

  async openInbox(tags: string[]): Promise<(KeyRef | null)[]> {
    const view = this.#inboxKey("view")
    return tags.map((t) => {
      try {
        const raw = inboxB64(t)
        if (raw.length !== TAG_BYTES) return null
        const shared = sharedFromTagX(raw.subarray(0, 32), view)
        if (!shared) return null
        const sec = inboxSecrets(shared, this.app)
        if (sec.viewTag !== raw[32]) return null
        const id = bytesToHex(raw.subarray(0, 32))
        this.#inbox.set(id, sec)
        return { kind: "inbox", id } as KeyRef
      } catch {
        return null
      }
    })
  }

  async envelopeSignerOf(ref: KeyRef): Promise<Address> {
    if (ref.kind !== "inbox") return this.addressOf(ref)
    return privateKeyToAccount(this.#inboxSecrets(ref).signKey).address
  }
}

/** A tag is 12 bytes of IV, 16 bytes of ciphertext and a 16-byte GCM tag: 44 bytes, 59 base64url chars. */
export const TAG_BYTES = 44

/** The key ref of a named scope. */
export function scopeRef(name: string): KeyRef {
  if (!name) throw new Error("scope name is empty")
  return { kind: "scope", id: bytesToHex(sha256(enc.encode(`arkognito/scope/${name}`)).subarray(0, 15)) }
}

function checkRef(ref: KeyRef) {
  const ok =
    ((ref?.kind === "record" || ref?.kind === "scope") && /^0x[0-9a-fA-F]{30}$/.test(ref.id)) ||
    (ref?.kind === "inbox" && /^0x[0-9a-fA-F]{64}$/.test(ref.id))
  if (!ok) throw new Error("bad key ref")
}

function passkeyRoot(secret: Uint8Array, app: string): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new Error("passkey secret must be at least 32 bytes")
  return hkdf(sha256, secret, undefined, enc.encode(`arkognito/root/v1/passkey/${app}`), 32)
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function toB64url(b: Uint8Array) {
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
