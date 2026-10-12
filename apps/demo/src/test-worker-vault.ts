// Browser test for key isolation (D3). Not part of the demo build; open /test-worker-vault.html.
// Uses a throwaway local key, so no wallet extension is needed.
import { tiramisu } from "@arkiv-network/sdk/chains"
import {
  KeyVault,
  OhttpGateway,
  ohttpCall,
  WorkerVault,
  createPrivateClient,
  envelopeSigner,
  parseEnvelope,
  scopeRef,
  sealEnvelope,
  signOwnershipProof,
  verifyOwnershipProof,
} from "arkognito"
import { createWalletClient, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail })

try {
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tiramisu, transport: http() })
  const app = "worker-test"
  const local = await KeyVault.fromWallet(wallet, app)
  const isolated = await WorkerVault.fromWallet(wallet, app)

  check("worker derives the same scope address", (await local.addressOf(scopeRef("p"))) === (await isolated.addressOf(scopeRef("p"))))
  const fromWorker = await isolated.newRecord()
  const [opened] = await local.openTags([fromWorker.tag])
  check("a tag made in the worker opens in another vault of the same wallet", opened?.id === fromWorker.ref.id)
  check("…and names the same address", (await local.addressOf(opened!)) === fromWorker.address)
  const fromLocal = await local.newRecord()
  check("the worker opens tags made elsewhere", (await isolated.openTags([fromLocal.tag]))[0]?.id === fromLocal.ref.id)

  const signer = await isolated.signer(fromWorker.ref)
  check("worker signers offer only Arkognito-shaped signing", Object.keys(signer).sort().join() === "address,signEnvelope,signProof")
  const attributes = { project: app, vtag: fromWorker.tag }
  const sealed = await sealEnvelope({ signer, app, payload: new TextEncoder().encode("hi"), contentType: "text/plain", attributes, expSeconds: 3600 })
  check("envelope signed inside the worker recovers to S", (await envelopeSigner(parseEnvelope(sealed.payload), attributes)) === signer.address)

  const entityKey = `0x${"cd".repeat(32)}` as const
  const proof = await signOwnershipProof(signer, { entityKey, challenge: "c", verifier: "v" })
  const fake = { getEntity: async () => ({ owner: signer.address }) } as never
  check("ownership proof signed inside the worker verifies", (await verifyOwnershipProof(proof, { challenge: "c", verifier: "v", client: fake })).ok)

  const ct = await isolated.encrypt(fromWorker.ref, new TextEncoder().encode("secret"))
  check("worker encryption round-trips through another vault of the same wallet", new TextDecoder().decode(await local.decrypt(fromWorker.ref, ct)) === "secret")

  const fields = Object.getOwnPropertyNames(isolated)
  check("the page-side vault object holds no key material", fields.join() === "app", `own fields: ${fields.join(",")}`)

  const { recoveryCode, vault: rnd } = await WorkerVault.random(app)
  const back = KeyVault.fromRecoveryCode(recoveryCode, app)
  const r = await rnd.newRecord()
  check("random-root mode in the worker round-trips its recovery code", (await back.openTags([r.tag]))[0]?.id === r.ref.id)

  // OHTTP encapsulation works in the browser (HPKE over WebCrypto / noble).
  const gateway = await OhttpGateway.fromSeed(crypto.getRandomValues(new Uint8Array(32)))
  const relayFetch = (async (_u: string, init: RequestInit) => {
    const opened = await gateway.open(new Uint8Array(init.body as ArrayBuffer))
    return new Response((await opened.seal({ status: 200, body: { path: opened.request.path } })).slice().buffer)
  }) as typeof fetch
  const echoed = await ohttpCall("http://relay", "http://relayer", gateway.publicKey, { method: "GET", path: "/v1/info" }, relayFetch)
  check("OHTTP round trip works in the browser", (echoed.body as { path: string }).path === "/v1/info")

  // createPrivateClient picks the worker by default in a browser.
  const client = await createPrivateClient({ app, wallet, relayers: ["http://127.0.0.1:9"] })
  check("createPrivateClient uses the worker vault in a browser", client.vault instanceof WorkerVault)
  check("…and it derives the same keys", (await client.scopeAddress("p")) === (await local.addressOf(scopeRef("p"))))
} catch (e) {
  check("no exception", false, (e as Error).stack)
}

const out = document.getElementById("out")!
out.textContent = JSON.stringify({ pass: results.every((r) => r.ok), results }, null, 2)
out.dataset.done = "1"
