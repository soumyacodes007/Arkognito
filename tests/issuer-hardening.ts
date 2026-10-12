// Issuer quota survives a restart, concurrent requests cannot overrun it, and the T4 monitor
// catches a token recorded twice in the shared spent list.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { ExpirationTime } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { ARKOGNITO_PROJECT, epochOf, fetchIssuerKey, issuanceMessage, toBase64, tokenSuite } from "arkognito"
import { type Hex, bytesToHex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { WriteQueue, arkivClients } from "../packages/relayer/src/arkiv"
import { Issuer, seedFromEnv } from "../packages/relayer/src/issuer"
import { createTokenGate } from "../packages/relayer/src/tokengate"
import { check, done, publicClient, runId } from "./helpers"

const rpc = process.env.ARKIV_RPC_URL!
const key = process.env.ARKIV_ACCESS_KEY
const quotaFile = `${process.env.TEMP ?? "/tmp"}/arkognito-quota-${runId}.json`
const app = `arkognito-quota-${runId}`
const log = (m: string) => console.log(`[issuer] ${m}`)
const issuerArkiv = arkivClients(rpc, key, process.env.ISSUER_WALLET_PRIVATE_KEY as Hex)
const newIssuer = () => new Issuer(issuerArkiv, new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), { quotaPerDay: 5, log, quotaFile })

const user = privateKeyToAccount(generatePrivateKey())

async function ask(issuer: Issuer, n: number) {
  const epoch = epochOf()
  await issuer.ensurePublished(app, epoch)
  const pub = (await fetchIssuerKey(publicClient, issuer.address, app, epoch))!
  const suite = tokenSuite()
  const blinded: string[] = []
  for (let i = 0; i < n; i++) {
    const { blindedMsg } = await suite.blind(pub.key, suite.prepare(crypto.getRandomValues(new Uint8Array(32))))
    blinded.push(toBase64(blindedMsg))
  }
  const ts = Date.now()
  const walletSignature = await user.signMessage({ message: issuanceMessage({ app, epoch, blinded }, ts) })
  return issuer.issue({ app, epoch, wallet: user.address, walletSignature, blinded, ts })
}

// ---- quota survives a restart ----------------------------------------------------------
const first = newIssuer()
const got = await ask(first, 3)
check("first issuer gives 3 tokens", got.blindSignatures.length === 3 && got.remaining === 2)
check("quota file exists and names no wallet", existsSync(quotaFile) && !readFileSync(quotaFile, "utf8").toLowerCase().includes(user.address.slice(2).toLowerCase()))
const restarted = newIssuer()
let refused = ""
try {
  await ask(restarted, 3)
} catch (e) {
  refused = (e as Error).message
}
check("after a restart the same wallet cannot take 3 more (2 left)", /quota/.test(refused), refused)
check("…but can take its remaining 2", (await ask(restarted, 2)).remaining === 0)

// ---- concurrent requests cannot overrun the quota -----------------------------------------
const racer = privateKeyToAccount(generatePrivateKey())
const raceIssuer = new Issuer(issuerArkiv, new WriteQueue(), seedFromEnv(process.env.ISSUER_RSA_SEED), { quotaPerDay: 5, log })
const askAs = async (n: number) => {
  const epoch = epochOf()
  const pub = (await fetchIssuerKey(publicClient, raceIssuer.address, app, epoch))!
  const suite = tokenSuite()
  const blinded = await Promise.all(
    Array.from({ length: n }, async () => toBase64((await suite.blind(pub.key, suite.prepare(crypto.getRandomValues(new Uint8Array(32))))).blindedMsg)),
  )
  const ts = Date.now()
  const walletSignature = await racer.signMessage({ message: issuanceMessage({ app, epoch, blinded }, ts) })
  return raceIssuer.issue({ app, epoch, wallet: racer.address, walletSignature, blinded, ts })
}
const race = await Promise.allSettled([askAs(3), askAs(3)])
check("two concurrent requests for 3 each: exactly one succeeds (quota 5)", race.filter((r) => r.status === "fulfilled").length === 1)

// ---- T4 monitor ----------------------------------------------------------------------------
const relay = arkivClients(rpc, key, process.env.RELAYER_1_PRIVATE_KEY as Hex)
const dupId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const marker = {
  payload: new Uint8Array(),
  contentType: "application/octet-stream",
  attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.spent", app, epoch: i32(epochOf()), tokenid: bytes32(dupId) },
  expires: ExpirationTime.fromHours(1),
}
await relay.walletClient.executeBatch({ creates: [marker, marker] })
const gate = createTokenGate(relay, issuerArkiv.address, (m) => console.log(`[gate] ${m}`))
const found = await gate.monitor!.scan()
check("T4 monitor reports a token recorded twice", found.includes(dupId))

rmSync(quotaFile, { force: true })
done()
process.exit()
