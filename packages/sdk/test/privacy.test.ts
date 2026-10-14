// Unit tests for the privacy upgrades: passkey roots (WebAuthn PRF) and inbox records (send to user).
import assert from "node:assert/strict"
import { test } from "node:test"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  type ArkognitoSigner,
  KeyVault,
  PasskeyPrfUnsupportedError,
  envelopeDigest,
  parseInboxAddress,
  passkeyPrfSalt,
  scopeRef,
  sealEnvelope,
  sealInbox,
  signOwnershipProof,
  verifyOwnershipProof,
  verifyRecord,
} from "../src/index.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * A software authenticator with the PRF extension, like a platform passkey: PRF(salt) =
 * HMAC(credential secret, "WebAuthn PRF" || 0 || salt), as browsers hash the web salt.
 */
function fakeAuthenticator(opts: { prf?: boolean; prfAtCreate?: boolean } = {}) {
  const creds = new Map<string, Uint8Array>()
  const prf = opts.prf ?? true
  let prompts = 0
  const idOf = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("hex")
  const evalPrf = (secret: Uint8Array, salt: Uint8Array) =>
    hmac(sha256, secret, sha256(new Uint8Array([...enc.encode("WebAuthn PRF"), 0, ...salt])))
  const credential = (rawId: Uint8Array, results?: { first: ArrayBuffer }, enabled?: boolean) => ({
    rawId: rawId.buffer,
    getClientExtensionResults: () => (prf ? { prf: { ...(enabled !== undefined ? { enabled } : {}), ...(results ? { results } : {}) } } : {}),
  })
  return {
    get prompts() {
      return prompts
    },
    async create(o: CredentialCreationOptions) {
      prompts++
      const rawId = crypto.getRandomValues(new Uint8Array(16))
      const secret = crypto.getRandomValues(new Uint8Array(32))
      creds.set(idOf(rawId), secret)
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first
      const first = opts.prfAtCreate ? evalPrf(secret, salt).slice().buffer : undefined
      return credential(rawId, first ? { first } : undefined, prf) as unknown as Credential
    },
    async get(o: CredentialRequestOptions) {
      prompts++
      const allow = o.publicKey!.allowCredentials ?? []
      const id = allow.length ? idOf(allow[0].id as Uint8Array) : [...creds.keys()][0]
      const secret = creds.get(id)
      if (!secret) return null
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first
      const rawId = new Uint8Array(Buffer.from(id, "hex"))
      return credential(rawId, prf ? { first: evalPrf(secret, salt).slice().buffer } : undefined) as unknown as Credential
    },
  }
}

// ---- passkey root ---------------------------------------------------------------------------------

test("passkey: create, then sign in again with one prompt, and get the same keys", async () => {
  const auth = fakeAuthenticator()
  const { vault, recoveryCode, credentialId } = await KeyVault.createPasskey("kendra-watch", { credentials: auth })
  assert.equal(vault.mode, "passkey")
  assert.match(recoveryCode, /^arkognito1-[0-9a-f]{64}$/)
  const before = auth.prompts
  const again = await KeyVault.fromPasskey("kendra-watch", { credentials: auth, credentialId })
  assert.equal(auth.prompts - before, 1, "signing in is one prompt")
  const s = scopeRef("profile")
  assert.equal(await again.addressOf(s), await vault.addressOf(s))
  assert.equal(await again.issuerIdentity(), await vault.issuerIdentity())
  assert.equal(await again.inboxAddress(), await vault.inboxAddress())
  // The recovery code restores the very same keys without the passkey.
  const restored = KeyVault.fromRecoveryCode(recoveryCode, "kendra-watch")
  assert.equal(await restored.addressOf(s), await vault.addressOf(s))
  const rec = await vault.newRecord()
  assert.equal((await restored.openTags([rec.tag]))[0]?.id, rec.ref.id)
})

test("passkey: PRF results returned at creation are used directly", async () => {
  const auth = fakeAuthenticator({ prfAtCreate: true })
  const { credentialId, vault } = await KeyVault.createPasskey("x", { credentials: auth })
  assert.equal(auth.prompts, 1, "no second prompt when the authenticator answers PRF at creation")
  const again = await KeyVault.fromPasskey("x", { credentials: auth, credentialId })
  assert.equal(await again.addressOf(scopeRef("p")), await vault.addressOf(scopeRef("p")))
})

test("passkey: another app or another passkey gives unrelated keys", async () => {
  const auth = fakeAuthenticator()
  const a = await KeyVault.createPasskey("kendra-watch", { credentials: auth })
  const otherApp = await KeyVault.fromPasskey("sketch", { credentials: auth, credentialId: a.credentialId })
  const otherKey = await KeyVault.createPasskey("kendra-watch", { credentials: fakeAuthenticator() })
  const s = scopeRef("profile")
  assert.notEqual(await otherApp.addressOf(s), await a.vault.addressOf(s))
  assert.notEqual(await otherKey.vault.addressOf(s), await a.vault.addressOf(s))
  assert.notDeepEqual(passkeyPrfSalt("kendra-watch"), passkeyPrfSalt("sketch"))
})

test("passkey: an authenticator without PRF is refused with a clear error", async () => {
  await assert.rejects(KeyVault.createPasskey("x", { credentials: fakeAuthenticator({ prf: false }) }), PasskeyPrfUnsupportedError)
  await assert.rejects(KeyVault.fromPasskey("x", { credentials: { create: async () => null, get: async () => null } }), /no passkey/)
  assert.throws(() => KeyVault.fromPasskeySecret(new Uint8Array(16), "x"), /32 bytes/)
})

// ---- inbox (send to user) -----------------------------------------------------------------------

const app = "kendra-watch"
const wallet = () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })

function senderSigner(acct: ReturnType<typeof privateKeyToAccount>): ArkognitoSigner {
  return {
    address: acct.address,
    signEnvelope: (body, attributes) => acct.signMessage({ message: { raw: envelopeDigest(body, attributes) } }),
    signProof: () => Promise.reject(new Error("no")),
  }
}

test("inbox: only the recipient finds the record, controls its owner and reads it", async () => {
  const alice = await KeyVault.fromWallet(wallet(), app)
  const bob = await KeyVault.fromWallet(wallet(), app)
  const inbox = await alice.inboxAddress()
  assert.match(inbox, /^arkognito-inbox1:[0-9a-f]{132}$/)

  const sealed = sealInbox(inbox, app)
  assert.equal(sealed.tag.length, 59, "an inbox tag is as long as every other tag")
  const [ref] = await alice.openInbox([sealed.tag])
  assert.ok(ref && ref.kind === "inbox")
  assert.equal(await alice.addressOf(ref), sealed.owner, "Alice controls the one-time owner")
  assert.equal(await alice.envelopeSignerOf(ref), sealed.envelopeSigner.address)
  assert.notEqual(sealed.owner, sealed.envelopeSigner.address, "the sender cannot sign as the owner")
  const ct = sealed.encrypt(enc.encode("stock report reminder"))
  assert.equal(dec.decode(await alice.decrypt(ref, ct)), "stock report reminder")

  assert.deepEqual(await bob.openInbox([sealed.tag]), [null], "Bob cannot open Alice's inbox tag")
  assert.deepEqual(await alice.openTags([sealed.tag]), [null], "an inbox tag is not a normal tag")
  const own = await alice.newRecord()
  assert.deepEqual(await alice.openInbox([own.tag]), [null], "a normal tag is not an inbox tag")
  const otherApp = await KeyVault.fromWallet(wallet(), "sketch")
  assert.deepEqual(await otherApp.openInbox([sealed.tag]), [null])
})

test("inbox: each send gets a fresh owner and tag", async () => {
  const alice = await KeyVault.fromWallet(wallet(), app)
  const inbox = await alice.inboxAddress()
  const a = sealInbox(inbox, app)
  const b = sealInbox(inbox, app)
  assert.notEqual(a.owner, b.owner)
  assert.notEqual(a.tag, b.tag)
  const refs = await alice.openInbox([a.tag, b.tag])
  assert.equal(await alice.addressOf(refs[0]!), a.owner)
  assert.equal(await alice.addressOf(refs[1]!), b.owner)
})

test("inbox: the envelope verifies against the sender key, and the recipient can prove ownership", async () => {
  const alice = await KeyVault.fromWallet(wallet(), app)
  const sealed = sealInbox(await alice.inboxAddress(), app)
  const attributes = { project: app, vtag: sealed.tag }
  const env = await sealEnvelope({
    signer: senderSigner(sealed.envelopeSigner),
    app,
    payload: sealed.encrypt(enc.encode("hi")),
    contentType: "text/plain",
    attributes,
    expSeconds: 3600,
    encrypted: true,
  })
  const entity = {
    key: `0x${"ab".repeat(32)}` as const,
    owner: sealed.owner,
    creator: privateKeyToAccount(generatePrivateKey()).address,
    payload: env.payload,
    attributes: attributes as never,
  }
  const [ref] = await alice.openInbox([sealed.tag])
  const signer = await alice.envelopeSignerOf(ref!)
  assert.ok((await verifyRecord(entity, { app, owner: sealed.owner, signer })).ok, "recipient verifies it")
  assert.equal((await verifyRecord(entity, { app })).ok, false, "a plain owner check fails: inbox records are recognisable as such")

  const proof = await signOwnershipProof(await alice.signer(ref!), { entityKey: entity.key, challenge: "c", verifier: "desk" })
  const check = await verifyOwnershipProof(proof, { challenge: "c", verifier: "desk", client: { getEntity: async () => ({ owner: sealed.owner }) } as never })
  assert.ok(check.ok, "the recipient proves ownership of a record someone else wrote for them")
})

test("inbox: malformed inbox addresses are refused", () => {
  assert.throws(() => parseInboxAddress("arkognito-inbox1:00"), /not an Arkognito inbox address/)
  assert.throws(() => parseInboxAddress(`arkognito-inbox1:${"05".repeat(66)}`), /invalid public key/)
  assert.throws(() => sealInbox("0x1234", app))
})
