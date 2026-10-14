// Runs inside a Web Worker. Holds the KeyVault; answers with addresses, tags, Arkognito-shaped signatures
// and ciphertext only (D3). It offers no "sign arbitrary bytes" operation.
import { KeyVault } from "./derive.ts"
import type { EnvelopeBody, IssuanceBody, KeyRef, ProofBody } from "./vault.ts"

export type VaultRequest =
  | { id: number; op: "fromSignature"; signature: `0x${string}`; app: string }
  | { id: number; op: "fromRecoveryCode"; code: string; app: string }
  | { id: number; op: "random"; app: string }
  | { id: number; op: "fromPasskeySecret"; secret: Uint8Array; app: string; recovery: boolean }
  | { id: number; op: "newRecord" }
  | { id: number; op: "scopeRecord"; name: string }
  | { id: number; op: "openTags"; tags: string[] }
  | { id: number; op: "addressOf"; ref: KeyRef }
  | { id: number; op: "signEnvelope"; ref: KeyRef; body: EnvelopeBody; attributes: unknown }
  | { id: number; op: "signProof"; ref: KeyRef; body: ProofBody }
  | { id: number; op: "encrypt"; ref: KeyRef; data: Uint8Array }
  | { id: number; op: "decrypt"; ref: KeyRef; data: Uint8Array }
  | { id: number; op: "issuerIdentity" }
  | { id: number; op: "signIssuance"; body: IssuanceBody }
  | { id: number; op: "inboxAddress" }
  | { id: number; op: "openInbox"; tags: string[] }
  | { id: number; op: "envelopeSignerOf"; ref: KeyRef }

let vault: KeyVault | undefined

const need = () => {
  if (!vault) throw new Error("vault is not initialised")
  return vault
}

async function handle(req: VaultRequest): Promise<unknown> {
  switch (req.op) {
    case "fromSignature":
      vault = KeyVault.fromSignature(req.signature, req.app)
      return null
    case "fromRecoveryCode":
      vault = KeyVault.fromRecoveryCode(req.code, req.app)
      return null
    case "fromPasskeySecret":
      vault = KeyVault.fromPasskeySecret(req.secret, req.app)
      // Only when the passkey is first created: the user must save this code.
      return req.recovery ? KeyVault.passkeyRecoveryCode(req.secret, req.app) : null
    case "random": {
      const r = KeyVault.random(req.app)
      vault = r.vault
      // The one time key material leaves the worker: the user must save this code.
      return r.recoveryCode
    }
    case "newRecord":
      return need().newRecord()
    case "scopeRecord":
      return need().scopeRecord(req.name)
    case "openTags":
      return need().openTags(req.tags)
    case "addressOf":
      return need().addressOf(req.ref)
    case "signEnvelope":
      return (await need().signer(req.ref)).signEnvelope(req.body, req.attributes as never)
    case "signProof":
      return (await need().signer(req.ref)).signProof(req.body)
    case "encrypt":
      return need().encrypt(req.ref, req.data)
    case "decrypt":
      return need().decrypt(req.ref, req.data)
    case "issuerIdentity":
      return need().issuerIdentity()
    case "signIssuance":
      return need().signIssuance(req.body)
    case "inboxAddress":
      return need().inboxAddress()
    case "openInbox":
      return need().openInbox(req.tags)
    case "envelopeSignerOf":
      return need().envelopeSignerOf(req.ref)
  }
}

self.onmessage = async (ev: MessageEvent<VaultRequest>) => {
  const { id } = ev.data
  try {
    self.postMessage({ id, ok: true, result: await handle(ev.data) })
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e as Error).message })
  }
}
