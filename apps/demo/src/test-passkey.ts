// Browser test for passkey roots (WebAuthn PRF) with real navigator.credentials. Not part of the demo
// build; tests/browser-passkey.ts opens it in Chrome with a virtual authenticator that supports PRF.
import { KeyVault, WorkerVault, createPrivateClient, scopeRef } from "arkognito"

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail })
const app = "passkey-test"

try {
  const created = await WorkerVault.createPasskey(app, { userName: "synthetic tester" })
  check("a passkey with PRF is created and its root lives in the worker", created.vault instanceof WorkerVault && /^arkognito1-[0-9a-f]{64}$/.test(created.recoveryCode))
  const s = scopeRef("profile")
  const first = await created.vault.addressOf(s)

  const again = await WorkerVault.fromPasskey(app, { credentialId: created.credentialId })
  check("signing in again with the passkey gives the same keys", (await again.addressOf(s)) === first)
  check("…and the same issuer identity and inbox address", (await again.issuerIdentity()) === (await created.vault.issuerIdentity()) && (await again.inboxAddress()) === (await created.vault.inboxAddress()))

  const inThread = await KeyVault.fromPasskey(app, { credentialId: created.credentialId })
  check("the same passkey gives the same keys outside the worker", (await inThread.addressOf(s)) === first)

  const other = await KeyVault.fromPasskey("another-app", { credentialId: created.credentialId })
  check("another app gets unrelated keys from the same passkey", (await other.addressOf(s)) !== first)

  check("the recovery code restores the same keys without the passkey", (await KeyVault.fromRecoveryCode(created.recoveryCode, app).addressOf(s)) === first)

  const fields = Object.getOwnPropertyNames(again)
  check("the page-side vault holds no key material", fields.join() === "app", `own fields: ${fields.join(",")}`)

  const client = await createPrivateClient({ app, passkey: { credentialId: created.credentialId }, relayers: ["http://127.0.0.1:9"] })
  check("createPrivateClient signs in with a passkey and keeps keys in the worker", client.vault instanceof WorkerVault && (await client.scopeAddress("profile")) === first)
} catch (e) {
  check("no exception", false, `${(e as Error).name}: ${(e as Error).message}`)
}

const out = document.getElementById("out")!
out.textContent = JSON.stringify({ pass: results.length > 0 && results.every((r) => r.ok), results }, null, 2)
out.dataset.done = "1"
