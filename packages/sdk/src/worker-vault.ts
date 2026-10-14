// Browser key isolation (D3): derived keys live in a dedicated Web Worker. The page holds only this
// proxy, which can ask for addresses, tags, envelope and proof signatures, and ciphertext, but can
// never read a key or have a key sign arbitrary bytes.
//
// Limit, stated plainly: a hostile page can still ask the worker for Arkognito signatures and ownership
// proofs, and it sees the wallet's derivation signature for the moment it takes to hand it over. The
// worker stops accidental leaks (analytics, error reporters, logging, state dumps) and arbitrary
// signing, not a malicious frontend.
import type { AttributeInputs, Attributes } from "@arkiv-network/sdk"
import type { Address, Hex } from "viem"
import { type DerivationOptions, KeyVault, type SigningWallet } from "./derive.ts"
import type { EnvelopeBody, IssuanceBody, KeyRef, NewKey, ProofBody, Vault, ArkognitoSigner } from "./vault.ts"
import type { VaultRequest } from "./vault.worker.ts"

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type Payload<T> = T extends unknown ? Omit<T, "id"> : never

export class WorkerVault implements Vault {
  #worker: Worker
  #seq = 0
  #pending = new Map<number, Pending>()

  private constructor(
    worker: Worker,
    readonly app: string,
  ) {
    this.#worker = worker
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.#pending.get(ev.data.id)
      if (!p) return
      this.#pending.delete(ev.data.id)
      ev.data.ok ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.error))
    }
  }

  /** The worker bundled with this package. Bundlers that support `new Worker(new URL(...))` pick it up. */
  static spawn(): Worker {
    return new Worker(new URL("./vault.worker.ts", import.meta.url), { type: "module", name: "arkognito-vault" })
  }

  #call<T>(req: Payload<VaultRequest>): Promise<T> {
    const id = ++this.#seq
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.#worker.postMessage({ ...req, id })
    })
  }

  static async fromWallet(wallet: SigningWallet, app: string, opts: DerivationOptions & { worker?: Worker } = {}) {
    const v = new WorkerVault(opts.worker ?? WorkerVault.spawn(), app)
    // The signature is handed straight to the worker and not kept on this side.
    await v.#call({ op: "fromSignature", signature: await KeyVault.signDerivation(wallet, app, opts), app })
    return v
  }

  static async fromRecoveryCode(code: string, app: string, opts: { worker?: Worker } = {}) {
    const v = new WorkerVault(opts.worker ?? WorkerVault.spawn(), app)
    await v.#call({ op: "fromRecoveryCode", code, app })
    return v
  }

  static async random(app: string, opts: { worker?: Worker } = {}) {
    const v = new WorkerVault(opts.worker ?? WorkerVault.spawn(), app)
    const recoveryCode = await v.#call<string>({ op: "random", app })
    return { vault: v, recoveryCode }
  }

  newRecord() {
    return this.#call<NewKey>({ op: "newRecord" })
  }

  scopeRecord(name: string) {
    return this.#call<NewKey>({ op: "scopeRecord", name })
  }

  openTags(tags: string[]) {
    return this.#call<(KeyRef | null)[]>({ op: "openTags", tags })
  }

  addressOf(ref: KeyRef) {
    return this.#call<Address>({ op: "addressOf", ref })
  }

  async signer(ref: KeyRef): Promise<ArkognitoSigner> {
    return {
      address: await this.addressOf(ref),
      signEnvelope: (body: EnvelopeBody, attributes: AttributeInputs | Attributes | undefined) =>
        this.#call<Hex>({ op: "signEnvelope", ref, body, attributes }),
      signProof: (body: ProofBody) => this.#call<Hex>({ op: "signProof", ref, body }),
    }
  }

  encrypt(ref: KeyRef, data: Uint8Array) {
    return this.#call<Uint8Array>({ op: "encrypt", ref, data })
  }

  decrypt(ref: KeyRef, data: Uint8Array) {
    return this.#call<Uint8Array>({ op: "decrypt", ref, data })
  }

  issuerIdentity() {
    return this.#call<Address>({ op: "issuerIdentity" })
  }

  signIssuance(body: IssuanceBody) {
    return this.#call<Hex>({ op: "signIssuance", body })
  }

  terminate() {
    this.#worker.terminate()
    for (const p of this.#pending.values()) p.reject(new Error("vault terminated"))
    this.#pending.clear()
  }
}
