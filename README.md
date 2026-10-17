# Veil / Arkognito

Privacy infrastructure for user-owned records on [Arkiv](https://arkiv.network).
The published TypeScript package is [**`arkognito@0.1.0`**](https://www.npmjs.com/package/arkognito/v/0.1.0);
anonymous group permissions use **`arkognito/semaphore`**.

Veil writes through shared relayers and gives each record a fresh owner address. Users can recover
records and prove ownership without publishing their main-wallet-to-record mapping. Optional
Semaphore proofs let approved group members submit without identifying which member submitted.

> Experimental, Tiramisu testnet only. Veil reduces wallet linkage; it does not provide complete
> anonymity. Public metadata, content, timing, small groups and network observations can identify
> users. No independent security audit has been performed. Use synthetic demo data only.

## What you can build

- Encrypted reporting and feedback with recoverable record ownership.
- Member-only polls and public signals with one accepted submission per enrolled identity and scope.
- Applications that separate public record ownership from a user's main wallet.

Your application decides who joins. Semaphore proves membership, not citizenship, unique personhood
or the truth of a report. Anon Aadhaar is an optional future admission integration; only its separate
synthetic test proof was exercised. A combined credential adapter is not included. ZK Email is deferred.

## Install

Use Node 22; the recorded integration ran on Node 22.23.3. Arkiv and viem are exact peer dependencies.

The pinned `@cloudflare/blindrsa-ts@0.4.6` declares Node `>=24`. A clean Node 22 install emits
`EBADENGINE` even though the recorded Node 22 tests pass; installations with `engine-strict`
enabled reject that mismatch. This dependency compatibility issue remains unresolved.

```bash
npm install arkognito@0.1.0 @arkiv-network/sdk@0.8.1 viem@2.57.4
```

To build a source checkout and create a local package instead:

```bash
npm ci
npm run build
npm pack --workspace=arkognito
```

Install the resulting `arkognito-0.1.0.tgz` alongside the pinned peers. The package is ESM.
Browser bundlers must support module workers created with `new Worker(new URL(..., import.meta.url))`.
The actual Vite worker flow passed the recorded integration.

## Write, find and prove a record

This Node example needs a running, funded local relayer. The client vault needs no gas. Preserve the
recovery code privately if you want to recover after restarting; never publish or log it.

```ts
import { KeyVault, createPrivateClient } from "arkognito"

const { vault, recoveryCode } = KeyVault.random("example-feedback")
const veil = await createPrivateClient({
  app: "example-feedback",
  vault,
  relayers: ["http://localhost:8787"],
})

const record = await veil.createEntity({
  payload: new TextEncoder().encode("Synthetic feedback"),
  contentType: "text/plain",
  attributes: { type: "feedback" },
  expires: 3600,
  encrypt: true,
})
const mine = await veil.myEntities()
const ownership = await veil.proveOwnership(record.entityKey, {
  challenge: "verifier-issued-single-use-challenge",
  verifier: "reviewer-1",
})
```

In browsers use `await WorkerVault.random(app)` or restore with
`WorkerVault.fromRecoveryCode(savedRecoveryCode, app)` to keep secrets inside a key worker.
Wallet and passkey-PRF sign-in are also supported. Wallet mode checks deterministic signatures;
passkeys need compatible browsers/authenticators and private recovery material. A hostile frontend
can still request allowed operations and observe plaintext.

## Anonymous group permissions with Semaphore

An admin creates a readonly group and enrolls approved public commitments. Users derive commitments
inside their own vaults; administrators never need user roots or recovery codes.

```ts
import { createPrivateClient } from "arkognito"

const commitment = await vault.membershipCommitment(group)
// Send commitment through your app's admission process; it does not enroll itself.

const veil = await createPrivateClient({
  app: group.project,
  vault,
  publicClient: reader,
  relayers: [relayerUrl],
  semaphore: { group },
})
```

Use normal `veil.createEntity(...)` after enrollment. The relayer checks the proof, historical root,
intended owner, scope and signed record binding, then creates a readonly record and transfers
ownership atomically. Configured projects require membership even when blind tokens are disabled;
valid membership replaces token redemption for those projects.

```ts
import { createSemaphoreReader } from "arkognito/semaphore"

const feed = createSemaphoreReader(reader, group, {
  trustedRelayers: [knownRelayerWallet],
  maxHistoryBlocks: 10000,
})
const { accepted, rejected, spent } = await feed.readPosts()
```

The earliest valid nullifier wins in block, transaction and log order. Deleted/expired winners
remain spent. Verification grants no ciphertext decryption. Arkiv has no application smart
contracts: relayers and readers verify proofs off-chain.

Read [the complete Semaphore guide](docs/semaphore.md) for administration, admission, artifact
hosting, relayer configuration, historical verification and recovery.

## How privacy works

| Layer | Purpose | Boundary |
| --- | --- | --- |
| One-time owners | Fresh addresses and encrypted discovery tags | An explicit owner-sharing scope deliberately links records |
| Shared relayer | Atomic create/transfer and gas payment | Sees request content/ciphertext, owner and timing |
| Encryption | Owner-encrypted records and recipient inboxes | Attributes remain public; disclosed plaintext cannot be recalled |
| Batching | Shuffling, envelope padding and lifetime buckets | Small batches and unusual attributes weaken privacy |
| Blind tokens | Separate issuance from redemption | Quotas limit issuance identities, not unique people |
| Optional OHTTP | Separate IP from request contents | Requires independent, non-colluding operators |
| Optional Semaphore | Anonymous membership and scoped duplicate policy | Group, scope and nullifier are public; admission is app policy |

`myEntities()` downloads shared listings and opens tags locally instead of sending an owner-address
set to the RPC. Larger apps fetch whole relevant batches plus cover batches. `proveOwnership()` is
an ordinary owner challenge proof, separate from a Semaphore membership proof.

Synthetic cover is available for eligible ordinary encrypted records. Membership records cannot
receive forged proof-bearing cover; minimum batch sizes need real valid submissions.

Native Arkiv already supports creation and ownership transfer. Veil packages derivation, recovery,
private discovery, relaying, verification and optional group authorization around those primitives.

## Run the services and demo

```bash
git clone https://github.com/soumyacodes007/Arkognito.git
cd Arkognito
npm ci
npm run setup
```

Setup creates signing material in gitignored `.env` and prints public addresses. Fund required
service addresses using the [Tiramisu faucet](https://hub.arkiv.network/faucet). Never commit keys
or expose RPC access keys in browser bundles.

```bash
npm run build
npm run dev:relayers
```

In another terminal, run `npm run dev:demo`. The existing Sketch App compares public/private writes
and includes an observer view. Docker is also supported; see [self-hosting](docs/self-hosting.md),
[deployment](docs/deploy-railway-vercel.md) and the [Node quickstart](examples/quickstart.mjs).
Public relayers need HTTPS. No public relayer URL or production admission service is promised here.

## Tests and measured evidence

The recorded integration on 17 October 2026 passed **46 offline tests and 32 live/browser checks**.
It exercised actual SDK/relayer calls, browser-worker proving, encrypted recovery, ownership transfer,
readonly creation, historical membership, malformed requests, replay rejection and spent-state
retention after deletion and actual expiry.

| Observation | Recorded result |
| --- | --- |
| Node full write/recovery | 23,830.97 ms |
| Browser full write/decryption | 28,856.50 ms, desktop headless Chrome |
| Final eight-transaction gas | 0.001851494003702988 testnet GLM |
| SDK build, typecheck, frontend build and compiled imports | Passed |

Times include proving, RPC, transaction waits and readback. These are individual observations, not
mobile or statistical benchmarks. The original synthetic linkage experiment used 50 records and
five synthetic users; its results are workload-specific, not an anonymity guarantee.
See [integration evidence](docs/semaphore-validation.md) and [linkage experiment](docs/linkage-experiment.md).

```bash
npm run build
npm run typecheck
npm test
npm run build -w arkognito-demo
```

Opt-in `npm run test:semaphore:live` writes synthetic Tiramisu records using the isolated funded
throwaway spike wallet. Stop other writers and run on-chain suites one at a time. Release checks
can use the recorded live evidence without repeating funded transactions.

## Operational limits

- One process controls each signing wallet; reuse one writer queue for all its operations.
- Persist the Semaphore journal. Uncertain writes and stale/corrupt journals require reconciliation;
  automatic cross-relayer failover and uncertain batch retries stop.
- Shared journals coordinate one host. Cross-host consensus and automatic repair are not implemented.
- Membership verification requires complete native logs, receipts and historical state. Work budgets
  are finite; long-lived apps need a durable authenticated index and retention policy.
- Membership is append-only. Immediate revocation and automatic group/member renewal are not supplied.
- One-time owners have no gas. The SDK supplies no sponsored update/delete/extension lifecycle;
  membership records are readonly and edits require new records.
- Expiry/deletion removes live state, not historical copies or transaction calldata.
- The last recorded dependency audit found 13 advisories (4 moderate, 9 high), without an exploitability
  assessment. Undiagnosed socket-listener warnings and proving-worker shutdown behavior are documented
  in the validation report.
- No independent audit, physical-passkey/mobile membership validation, production Aadhaar/email
  adapter, unique-person guarantee or complete network anonymity is claimed.

## Documentation and repository

| Path | Contents |
| --- | --- |
| `packages/sdk` | npm package, vaults, envelopes, client and optional Semaphore module |
| `packages/relayer` | Relayer, issuer, OHTTP relay and admission coordinator |
| `apps/demo` | Public/private Sketch App and observer view |
| `spec/SPEC.md` | Protocol and wire format for independent implementations |
| `arkiv/schema.md` | Entities, typed attributes, lifetimes and queries |
| `arkiv/friction.md` | Reproducible Arkiv integration feedback |
| `docs/semaphore.md` | Group authorization and independent reader guide |
| `docs/semaphore-validation.md` | Recorded tests, measurements and remaining limits |
| `spikes`, `tests` | Isolated feasibility experiments and test suites |

The [documentation site source](https://github.com/soumyacodes007/docs) includes SDK/API references,
operations and an Anon Aadhaar guide. The latter describes the admission boundary; it does not
provide a completed credential adapter.

MIT licensed. Other teams can run the services and build compatible clients from the documented
protocol. Keep real personal data, credential-derived hashes/nullifiers, secrets and private
admission mappings off Arkiv. Demonstrations use synthetic data only.
