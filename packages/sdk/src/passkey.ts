// Passkey root: derive the Arkognito root from a passkey instead of a wallet signature, through the
// WebAuthn PRF extension. PRF returns the same 32 secret bytes every time for one passkey, one site
// and one input, so the root (and every key under it) comes back on each sign-in.
//
//   salt   = sha256("arkognito/passkey/v1|" + app)            the PRF input, one per app
//   secret = PRF(passkey, salt)                                 32 bytes, from the authenticator
//   root   = HKDF-SHA256(secret, info = "arkognito/root/v1/passkey/" + app)
//
// The secret is bound to that passkey: delete it, or move to an authenticator that does not sync
// it, and the keys are gone. So creating a passkey root always hands back a recovery code, the same
// one random-root mode uses (`fromRecoveryCode` restores the exact same keys).
import { sha256 } from "@noble/hashes/sha2.js"

export class PasskeyPrfUnsupportedError extends Error {
  constructor(detail = "") {
    super(
      "This passkey or browser does not support the WebAuthn PRF extension, so Arkognito cannot derive keys from it" +
        (detail ? ` (${detail})` : "") +
        ". Use a wallet, or random-root mode with a recovery code.",
    )
  }
}

export type PasskeyOptions = {
  /** Relying party id (your domain). Default: the page's own. A passkey only works under the id it was created for. */
  rpId?: string
  /** Shown by the authenticator when creating the passkey. */
  rpName?: string
  /** Shown by the authenticator when creating the passkey. Not stored anywhere by Arkognito. */
  userName?: string
  /** Sign in with this credential (base64url) instead of letting the user pick one. */
  credentialId?: string
  /** WebAuthn entry point. Default: `navigator.credentials`. Tests pass a virtual one. */
  credentials?: Pick<CredentialsContainer, "create" | "get">
}

const enc = new TextEncoder()

/** The PRF input for one app. Different apps get unrelated secrets from the same passkey. */
export function passkeyPrfSalt(app: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(sha256(enc.encode(`arkognito/passkey/v1|${app}`)))
}

function container(opts: PasskeyOptions) {
  const c = opts.credentials ?? (globalThis.navigator as Navigator | undefined)?.credentials
  if (!c) throw new PasskeyPrfUnsupportedError("no WebAuthn in this environment")
  return c
}

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

type PrfOutput = { enabled?: boolean; results?: { first?: BufferSource } }

function prfOf(cred: Credential | null): PrfOutput | undefined {
  const pk = cred as (PublicKeyCredential & { getClientExtensionResults(): { prf?: PrfOutput } }) | null
  return pk?.getClientExtensionResults?.().prf
}

function bytes(b: BufferSource): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

/** Asks the authenticator for this app's PRF secret. One user prompt (biometric or PIN). */
export async function getPasskeySecret(app: string, opts: PasskeyOptions = {}): Promise<{ credentialId: string; secret: Uint8Array }> {
  const cred = await container(opts).get({
    publicKey: {
      challenge: rand(32),
      rpId: opts.rpId,
      userVerification: "required",
      allowCredentials: opts.credentialId ? [{ type: "public-key", id: fromB64url(opts.credentialId) }] : [],
      extensions: { prf: { eval: { first: passkeyPrfSalt(app) } } } as AuthenticationExtensionsClientInputs,
    },
  })
  if (!cred) throw new Error("no passkey was chosen")
  const first = prfOf(cred)?.results?.first
  if (!first) throw new PasskeyPrfUnsupportedError("the authenticator returned no PRF result")
  const secret = bytes(first)
  if (secret.length < 32) throw new PasskeyPrfUnsupportedError("PRF result is too short")
  return { credentialId: toB64url(new Uint8Array((cred as PublicKeyCredential).rawId)), secret }
}

/**
 * Creates a new passkey with PRF enabled and returns its secret for this app. Some authenticators
 * return the PRF result at creation; for the rest this asks once more, right away.
 */
export async function createPasskeySecret(app: string, opts: PasskeyOptions = {}): Promise<{ credentialId: string; secret: Uint8Array }> {
  const cred = await container(opts).create({
    publicKey: {
      challenge: rand(32),
      rp: { name: opts.rpName ?? "Arkognito", ...(opts.rpId ? { id: opts.rpId } : {}) },
      // A random handle: Arkognito keeps no account, so nothing ties this passkey to a person.
      user: { id: rand(16), name: opts.userName ?? "arkognito", displayName: opts.userName ?? "Arkognito keys" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: passkeyPrfSalt(app) } } } as AuthenticationExtensionsClientInputs,
    },
  })
  if (!cred) throw new Error("no passkey was created")
  const credentialId = toB64url(new Uint8Array((cred as PublicKeyCredential).rawId))
  const prf = prfOf(cred)
  if (prf?.enabled === false) throw new PasskeyPrfUnsupportedError("the authenticator did not enable PRF")
  const first = prf?.results?.first
  if (first && bytes(first).length >= 32) return { credentialId, secret: bytes(first) }
  return getPasskeySecret(app, { ...opts, credentialId })
}

function toB64url(b: Uint8Array) {
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
