# Arkognito: use Arkiv incognito

> **Status: experimental, testnet only (Arkiv Tiramisu).** Version 0.x: the protocol may still change.
> The cryptography has not had an outside audit yet.

On Arkiv every entity records its `$owner` and `$creator`, and both are queryable. One query,
`$owner = addr(<wallet>)`, lists everything a wallet ever wrote, in every app.

Arkognito keeps each record owned by its user while making records impossible to group by person:

1. Your wallet signs one message. From it the SDK derives a private root key, in your browser, in a Web Worker.
2. Each record gets its own one-time owner address `S`, from a fresh random key. The record carries
   the key's id encrypted to you, so only you can find your records again, from any device.
3. A shared relayer creates the record and hands ownership to `S` in the same transaction, so
   `$creator` is the relayer (shared by everyone) and `$owner` is used once.
4. The relayer batches requests from many users, shuffles them, and pads every record to a fixed size.
5. Rate limits use blind tokens: the relayer can enforce "N records per person per day" without
   learning who sent which record.
6. Optionally, requests go through an Oblivious HTTP relay so the relayer never sees your IP.

You can still find all your records (`myEntities()`) and prove that one is yours (`proveOwnership()`).

Measured on Tiramisu with 5 users and 50 records, an outside observer linked records with 11–16 %
precision, below the 20 % of random guessing. Without Arkognito an owner query links 100 %.
See [docs/linkage-experiment.md](docs/linkage-experiment.md).

## What is in this repository

| Part | Path | For |
| --- | --- | --- |
| **SDK** (`arkognito` on npm) | `packages/sdk` | App builders: make writes private, find and prove your records |
| **Relayer + token issuer** | `packages/relayer` | Anyone: run your own, or use someone else's |
| **OHTTP relay** | `packages/relayer` (`ROLE=ohttp-relay`) | A different operator than the relayers |
| **Docker Compose stack** | `docker-compose.yml`, `deploy/` | Self-hosting the whole network in one command |
| Protocol spec | `spec/SPEC.md` | Writing a compatible client or relayer |
| Edge cases | `docs/edge-cases.md` | Every known edge case, its status and the test that shows it |
| Demo | `apps/demo` | Arkiv's Sketch App, public vs private, and an observer view |

Nothing depends on us: every service is open source, and all shared state lives on Arkiv.

## Use the SDK in an app

```bash
npm install arkognito @arkiv-network/sdk@0.8.1 viem
```

```ts
import { createPrivateClient } from "arkognito"

const ark = await createPrivateClient({ app: "my-app", wallet })              // wallet: viem or Arkiv SDK wallet client
const { entityKey } = await ark.createEntity({ payload, contentType, attributes, expires })
const mine = await ark.myEntities()                                            // all of your records, verified
const proof = await ark.proveOwnership(entityKey, { challenge, verifier: "desk-1" })
```

`createEntity` takes the same parameters as `@arkiv-network/sdk`'s `createEntity` (plus optional
`scope` and `encrypt`). Relayers are found from their heartbeat entities on Arkiv; pass
`relayers: [url, …]` to use your own, and `ohttpRelay: url` to hide your IP from them. When a
relayer requires rate-limit tokens, the client fetches the day's tokens at session start.

Connecting costs one wallet prompt. The first time a device sees a wallet for an app it asks
twice, to check that the wallet signs deterministically (K1), and remembers a fingerprint of the
signature in `localStorage`; after that it asks once. Tokens are requested by an identity derived
from your root key, so they need no prompt and the issuer never sees your wallet.

### No wallet? Sign in with a passkey

```ts
import { WorkerVault, createPrivateClient } from "arkognito"

// Once: create a passkey. Show the recovery code to the user; it is the only backup.
const { recoveryCode, credentialId } = await WorkerVault.createPasskey("my-app")
// Every visit after: one biometric or PIN prompt, no wallet, no extension.
const ark = await createPrivateClient({ app: "my-app", passkey: { credentialId } })
```

The root comes from the passkey's WebAuthn PRF secret for this app, so it works for people with
no wallet and for smart-contract wallets. Browsers or authenticators without PRF get a clear error.

### Write a record for someone else

```ts
const inbox = await alice.inboxAddress()          // Alice shares this string ("arkognito-inbox1:…")
await bob.sendTo(inbox, { payload, contentType, attributes, expires })
const mine = await alice.myEntities()             // with createPrivateClient({ …, inbox: true })
```

The record is owned by a one-time address only Alice controls, encrypted to her, and written by the
relayer, so nothing on chain names Alice or Bob. Alice can read it and prove she owns it; Bob cannot.

### Reads and small batches

- Apps with up to 500 records (`fetchAllUnder`) are downloaded whole when you read your records,
  so the RPC provider learns nothing about which are yours. Bigger apps fetch your batches plus
  cover batches.
- A relayer started with `COVER_MIN_BATCH=5` pads a lone **encrypted** record into a batch of 5 with
  cover records nobody can tell apart from real ones. The result says how many were cover.

Making Arkiv's MetaMask Sketch App private took 3 changed lines:
compare [`apps/demo/src/store-public.ts`](apps/demo/src/store-public.ts) with
[`store-private.ts`](apps/demo/src/store-private.ts).

### Before you write

- Attribute names must be lowercase (`minbatch`, not `minBatch`): the node rejects uppercase.
- Lifetimes are rounded up to 1 hour, 1 day, 7 days, 30 days or 90 days; records are padded to
  512 B, 1 KB, 4 KB or 16 KB. Both stop records standing out.
- `ark.check({ attributes, expires, payload })` and every write warn about exact timestamps, precise
  locations, postal codes, free text, and attribute values shared by fewer than 3 other records
  (`rarityK`). `coarse.day/hour/geo/bucket` give you safer values; `strict: true` refuses such writes.
- `minAnonymity: 5` makes the relayer hold a record until it can be written among at least 5,
  or fail it, instead of writing it alone in a quiet hour.
- Expiry hides a record from queries but does not erase it: the payload stays in the transaction
  history. Use `encrypt: true` for anything private.
- Writes take about 25–30 s on a busy relayer (batching is what hides you), up to about 90 s when
  it is quiet. Show a "saving privately" state rather than a spinner.
- Do not load third-party analytics or error reporters on pages that use Arkognito.

## Self-host the infrastructure

The whole network (two relayers, the token issuer and an OHTTP relay) in one command:

```bash
git clone https://github.com/soumyacodes007/Arkognito.git && cd Arkognito
npm ci
npm run setup                          # creates wallets + issuer seed in .env, prints addresses to fund
OHTTP_ALLOW_LOCAL=on docker compose up -d
```

Fund the printed addresses at the [Tiramisu faucet](https://hub.arkiv.network/faucet). To put the
demo online on Railway + Vercel, follow **[docs/deploy-railway-vercel.md](docs/deploy-railway-vercel.md)**. For a public
deployment with HTTPS, Railway or Fly, running without Docker, the full configuration reference
and operations notes, see **[docs/self-hosting.md](docs/self-hosting.md)**.

Without Docker: `npm run build`, then `npm run relayer` (one relayer) or `npm run dev:relayers`
(two relayers + issuer), and `npm run ohttp-relay`.

With a relayer running, `node examples/quickstart.mjs` writes one private record with a throwaway
wallet (no funds needed), finds it with `myEntities()`, and shows that an owner query on the wallet
finds nothing.

For a live demo, `npm run demo:crowd` runs synthetic users that save synthetic sketches through the
live relayers (throwaway keys, no funds), so a demo save lands in a full shuffled batch. Start it about
two minutes before recording: each new user's first token has to be 60 seconds old before it is spent.

Every edge case we know of and how it is handled: [docs/edge-cases.md](docs/edge-cases.md).

## Tests

```bash
npm test                 # unit tests, offline
npm run typecheck
npm run test:phase2      # SDK core on Tiramisu: 200 records, myEntities, tamper and wrong-owner relayers
npm run test:phase3      # two relayers, failover, heartbeat expiry, linkage experiment (~6 min)
npm run test:phase4      # blind tokens: quota, double spend, unlinkability, issuer equivocation
npm run test:phase5      # Sketch App diff, check(), end to end (needs npm run dev:relayers)
npm run test:issuer      # issuer quota across restarts, concurrent requests, double-spend monitor
npm run test:privacy     # cover records, inbox (send to user), passkey users, download-all reads, on Tiramisu
npm run test:passkey     # passkey roots in headless Chrome with a virtual PRF authenticator (needs npm run dev:demo)
npm run test:edge        # edge-case sweep: read privacy, devices, encryption, crash recovery, minAnonymity, OHTTP, limits, attestation
RELAYERS=https://a,https://b npm run test:popup   # wallet prompts at connect (2 first visit, 1 after), against live relayers
```

The on-chain tests need `RELAYER_1_PRIVATE_KEY`, `RELAYER_2_PRIVATE_KEY`, `ISSUER_WALLET_PRIVATE_KEY`,
`ISSUER_RSA_SEED` (and `DEMO_USER_PRIVATE_KEY` for phase 5) in `.env`. Run them one at a time: they
share relayer wallets. All test data is synthetic.

## Repo

```
packages/sdk        arkognito: derivation, worker vault, envelope, client, check, proofs, tokens
packages/relayer    relayer, batcher, heartbeat, token gate, issuer, OHTTP relay (start.ts picks the role)
docker-compose.yml  the whole network: relay-1 + issuer, relay-2, OHTTP relay
deploy/             HTTPS with Caddy
scripts/setup.ts    npm run setup: wallets, issuer seed, addresses to fund
apps/demo           public vs private Sketch App, observer view, wallet check
spec/SPEC.md        protocol, so others can reimplement it
arkiv/schema.md     entity types, attributes, lifetimes, the queries behind each claim
arkiv/friction.md   reproducible Arkiv rough edges we hit
docs/               self-hosting guide, edge-case register, linkage experiment
spike/              the scripts that tested the design's assumptions on Tiramisu
tests/              phase tests
examples/           quickstart.mjs: plain Node, one private record end to end
```

## Threat model and limits

| Who | Sees | Does not learn |
| --- | --- | --- |
| Anyone reading Arkiv | all records, owners, creators, batches | which records belong to the same person |
| Relayer | records, one-time owners, request times, IP addresses | which wallet sent which record |
| Issuer | a per-app identity derived from your root key, how many tokens it took | your wallet, and which records those tokens paid for |

Said plainly:

- Without `ohttpRelay`, the relayer sees IP addresses. With it, requests go through an Oblivious
  HTTP relay (`npm run ohttp-relay`): the relay sees your IP but not the request, the relayer sees
  the request but not your IP. That holds only if the two are run by different people.
- Anonymity is as large as each batch. Set `minAnonymity` to refuse small batches, or run relayers
  with `COVER_MIN_BATCH` so encrypted records are padded with cover; otherwise the client reports the
  size it landed in. Cover only works for encrypted records, and the relayer knows which are cover.
- Quotas are per (wallet, app) identity, and wallets are free, unless the issuer requires
  attestation codes (`ISSUER_CODES_FILE`, for example codes handed out in person), which limit people
  instead. An issuer that must see the wallet itself can be served with `tokenIdentity: "wallet"`.
- The page that runs Arkognito can still ask the key worker for Arkognito signatures and ownership proofs.
  The worker stops key leaks and arbitrary signing, not a hostile frontend.
- Content can identify a person on its own. `check()` helps but cannot catch everything.
- Records are create-only: `S` holds no gas, so it cannot patch, extend or delete. Updates are new records.
- Smart-contract wallets cannot use signature mode; they, and people with no wallet, can use a passkey.
  A passkey root is lost with the passkey, so creating one returns a recovery code.
- An inbox record is recognisable as an inbox record (its envelope is not signed by its owner), but
  not who it is for, who sent it or what it says.

## License

MIT
