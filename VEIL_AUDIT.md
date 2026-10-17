# Veil / Arkognito static audit

Date: 17 October 2026 (IST). Baseline commit: `612316429d8320fe7d30417ae505b1e24c9baf71`. Phase 1 used file reads, `rg`, Git status/log/diffs only. No existing repository code was executed, built, installed or tested. BUILT means implementation found, **not** runtime certification. Phase 2 experiments are separate under `spikes/`.

The initial checkout was on `main` with modified SDK envelope/index/protocol/vault and relayer batcher/config/cover/server, plus untracked keeper/seal/shamir/seal-test files. These were included in this working-tree review and left intact. They are not all present in the baseline commit. Subsequent audit work is on `zk-feasibility`; nothing is pushed.

## Repository map

| Location | Entry points and purpose |
|---|---|
| `packages/sdk` | `src/index.ts` exports `createPrivateClient`, `KeyVault`, `WorkerVault`, reader, ownership proofs, blind tokens, OHTTP, inbox, PRF and working-tree seal helpers. Published `arkognito@0.1.0`; source condition `arkognito-source`; default `dist/index.js`. |
| `packages/relayer` | `src/start.ts` chooses relayer or OHTTP relay; `main.ts` loads configuration, issuer and token gate; `dev.ts` starts local services; server/batcher/heartbeat/issuer implement the service. |
| `apps/demo` | Vite multi-page `index.html`, public/private sketch, observer, determinism pages; `src/store-private.ts` and `store-public.ts` are storage entry points. Separate passkey/worker test pages exist. |
| `tests` | `phase2.ts`, `phase3.ts`, `phase4.ts`, `phase5.ts`, `edge-cases.ts`, `issuer-hardening.ts`, `privacy-upgrades.ts`, `browser-passkey.ts`, `one-popup-e2e.ts`; `helpers.ts`, `observer.ts` support integration tests. Test presence is not a passing result. |
| Package tests | `packages/sdk/test/{unit,privacy,seal}.test.ts`, `packages/relayer/test/cover.test.ts`; seal test was initially untracked and is absent from root `npm test`. |
| `spike` (singular) | Existing batch-transfer, expiry, attribute and pagination experiments; not run in this audit. |
| `scripts`, `examples` | `setup.ts`, `setup-wallets.ts`, `demo-crowd.ts`; plain-Node `examples/quickstart.mjs`. |
| Documentation | README, SDK README, PRD, SECURITY, `spec/SPEC.md`, schema/friction logs, linkage experiment, edge cases and deployment/self-hosting guides. MIT licenses at root and SDK. |
| Deployment | Node 22 Dockerfile; Compose runs two relayers and OHTTP, optional Caddy TLS overlay; Railway Dockerfile deploy, one replica, `/healthz`; Vercel builds demo to `apps/demo/dist`; Vite source export condition configured. |

Root manifests pin Arkiv `0.8.1`, viem `2.57.4`, tsx `4.23.15`, TypeScript `7.0.2`, Node types `26.6.4`, and require Node `22.x`. SDK dependencies: blindrsa `0.4.6`, HPKE core `1.9.0`, X25519 HPKE `1.8.0`, noble ciphers/hashes `2.4.0`, curves `1.9.1`; peers Arkiv `0.8.1`, viem `^2.57.4` (consumer viem is a range). Relayer pins Arkiv/viem/tsx and blindrsa/hashes; demo uses Vite `8.3.4`.

Root scripts: `typecheck`, `build` (SDK), `test` (unit/privacy/cover); phase tests `test:phase2/3/4/5`, issuer/edge/popup/privacy/passkey tests; `spike`, `relayer`, `dev:relayers`, `dev:demo`, `demo:crowd`, `ohttp-relay`, `setup`. SDK build runs tsc then worker-URL rewrite; prepack builds. Relayer start omits the source condition and depends on built SDK; dev uses it. On-chain tests share existing wallets and must run serially; none were run here.

## Feature evidence

| Feature | Status | File and function evidence / remaining work |
|---|---|---|
| EIP-712 + HKDF derived addresses | BUILT | `packages/sdk/src/derive.ts:67` `derivationTypedData`; `KeyVault.signDerivation:187`, `fromSignature:220`, `childPrivateKey:87`, `newRecord:308`, `scopeRecord:313`. Determinism and contract-wallet checks exist. |
| Relayer create + ownership transfer | BUILT | `packages/relayer/src/batcher.ts:162` `Batcher.#send` predicts under `WriteQueue`, then `executeBatch` creates and transfers at lines 183–185. Recovery risks below. |
| Blind tokens | PARTIAL | `sdk/src/tokens.ts` `TokenWallet.acquire/source`, `verifyToken`; `relayer/src/issuer.ts` `Issuer.issue`, `ensurePublished`; `tokengate.ts` `createTokenGate`. Missing trusted creator scoping on spent reads, cleanup of reservations, and deterministic rejection of cross-relayer double spends (monitor only reports). Wallet-based quotas are not proof of unique people. |
| Batching/shuffle | PARTIAL | `batcher.ts:52` `shuffle` is rejection-sampled cryptographic Fisher–Yates; `tick`, `#candidates`, `#send`; `cover.ts` `coverLike/coverFor`. Error splitting can reduce a batch below promised anonymity, and failed pre-write hooks can strand removed requests. Needs invariant checks on the final batch and recovery on exceptions. |
| Download-and-filter reads | BUILT | `reader.ts:116` `listApp` pins atBlock and walks pages; `fetchBatches:153`, `fetchProject:183`; `client.ts:290` `fetchCovered` downloads all under 500, otherwise matching + cover batches. Scaling/privacy limits remain. |
| Passkey PRF | BUILT | `passkey.ts:64/86` `getPasskeySecret/createPasskeySecret`, `derive.ts:232` `fromPasskeySecret`, WorkerVault wrappers. Unsupported PRF explicitly errors. Existing browser test file is evidence of coverage intent, not a new result. |
| Encryption | BUILT | `inbox.ts:122/127` `sealData/openData` AES-GCM; `derive.ts:281/357/361` per-reference keys/encrypt/decrypt; `client.ts:383` opt-in encryption and always-encrypted `sendTo`. Public attributes remain public. |
| Sealed expiry upgrade (working tree) | PARTIAL | `seal.ts` `sealPayload/openPayload`, `shamir.ts` `split/combine`, `keeper.ts` `Keeper` endpoints exist. `client.ts` does not orchestrate seal/share deposit/bind/release, and `myEntities:522` decrypts only enc=1. README/schema do not describe enc=2. No secure-erasure guarantee against readers/keepers retaining keys. |
| myEntities | BUILT | `client.ts:495` opens tags locally, verifies derived owner and envelope, decrypts enc=1, locally filters/sorts. Sealed records need integration above. |
| proveOwnership | BUILT | `client.ts:532`, `proof.ts:34/52` `signOwnershipProof/verifyOwnershipProof`; EIP-712 audience/challenge/deadline and current owner checked. These are ordinary ECDSA proofs, not ZK. |
| Semaphore / other ZK | MISSING | No dependencies/imports/implementation found across packages, demo, tests/spec. PRD D5 explicitly excludes ZK multi-record ownership. Shamir and blind RSA are not ZK membership proofs. |
| README | BUILT | Root and package README document API, threat model, deployment and scripts. Existing measurements are historical claims, not rerun in this audit. |
| `arkiv/schema.md` | PARTIAL | Describes app envelopes, issuer keys, spent markers, heartbeat and queries. Missing working-tree enc=2/sealed lifecycle and any Semaphore schemas. |
| `arkiv/friction.md` | BUILT | Seven existing reproducible entries covering expiry/history, prediction race, uppercase attributes, wallet types, cursor changes, createdAt and stale docs. |
| Demo | BUILT | Public/private Sketch App, observer/determinism pages and wallet flow present. Private store omits `encrypt:true`, so sketch contents are public. No ZK UI. |

No TODO/FIXME or Semaphore placeholder implementations were found in the searched application/SDK/test files; PARTIAL findings above are concrete integration/security gaps, not invented TODOs.

## Secrets and Git history

Read all eight available commits with `git log --all -p` and inspected tracked configuration/history for private-key assignments, 32-byte hex literals, recovery codes, private PEM headers and common API-key markers. No committed credential value was found in those patterns. The only literal 32-byte hex match in history was the public secp256k1 order constant in `derive.ts`, introduced by `87fe99d8574a52600f2b8d8ce32e28a5d6a611df`; it is not a key. `.env.example` was introduced in that commit with empty secret fields. Deployment guide assignments in `59faf9ec12beb51259379f8b9a17c55da58f35d9` are placeholders. `wallets.md` contains public testnet addresses, not private keys.

An untracked/ignored root `.env` exists. Its secret values were not printed or used for signing. During the later risk follow-up, only its RPC access key was read for server-side `X-API-KEY` headers after anonymous queries hit HTTP 429; all signing used fresh spike wallets. `.gitignore` excludes `.env`, `.env.*` except `.env.example`, `/data`, quota JSON and node_modules. The scan covers available Git refs, not unreachable objects, external deployment secret stores, unrecognized credential formats or proof of absence. No keys are included in these reports. Fresh spike signing keys belong only in gitignored `spikes/.env`.

## What goes to Arkiv / personal-data rule

* App entities: caller attributes + app `project` + randomized encrypted `vtag` (`client.ts:425`); public one-time owner and shared creator; JSON envelope `{v,app,ct,exp,enc,data,sig,pad}`. `enc=0` is **base64 plaintext**, not encryption. `sig` is a derived-owner envelope signature, not the main wallet's derivation signature. `enc=1` encrypts payload only. Scoped records intentionally reuse owners.
* Issuer key: public RSA SPKI/scheme with project/type/app/epoch (`issuer.ts:121–125`). No issuer private key or quota/attestation data is sent.
* Spent marker: empty payload; project/type/app/epoch and SHA-256 of a random prepared blind-token message (`tokengate.ts:85–90`), not a hash of personal data.
* Relayer heartbeat: URL/version/minbatch/token mode/public OHTTP key (`heartbeat.ts:51–55,66–72`); service metadata, not user identity.
* Cover records copy app metadata with random owners, tags/ciphertext/token IDs (`cover.ts`). Seal headers expose random seal ID, threshold and keeper service addresses; shares stay in keeper memory/off Arkiv.

No inspected write path intentionally publishes a root, main-wallet derivation signature, main-to-derived mapping, issuer private key or attester data. Issuer HMAC quota records and attestation-code hashes remain local (`issuer.ts:29–32,58–82,141–149`). Logs are local, not Arkiv entities.

**Compliance is conditional on caller data, not enforced by this SDK.** `checkRecord` scans attributes heuristically and checks payload size; it does not inspect payload contents or detect email hashes, and `strict` defaults false. The private sketch demo sends arbitrary user drawings as plaintext (`store-private.ts:19–24`). Synthetic sketches satisfy the rule; real signatures, names or other personal drawings would not. Plaintext metadata containing personal data still violates the rule even with encrypted payload. Phase 1 does not inspect existing chain data and cannot certify that deployed users have only submitted synthetic content. ZK Email/Aadhaar raw data, extracted identity fields, and personal-data hashes must stay off Arkiv; use synthetic fixtures and domain-separated random-secret commitments only.

## Bugs and risks noticed by reading (not runtime-confirmed exploits)

| Severity | Evidence | Consequence and correction |
|---|---|---|
| High | `relayer/src/tokengate.ts:39–45,51–60` | Anyone can publish counterfeit spent history or duplicate-monitor entries; no `.createdBy(trustedRelayer)` on lookup/monitor. Premarking an unspent token requires knowing its random ID; the finding does not imply those IDs can be guessed. Scope to configured trusted creators and pin scans. |
| High | `relayer/src/batcher.ts:183–219` | Broad catch includes receipt/read/decode failures after a successful send, then splits/resubmits. This can duplicate records and spend gas twice. Preserve hash, reconcile receipt and created keys before any resend. |
| High | `relayer/src/batcher.ts:119–125,142–158,214–219` | Items leave queue before hook/cover/prediction completes; hook failures can leave status queued forever. Splitting or token rejection shrinks batches below minAnonymity without recheck. Persist/requeue safely and enforce minimum at every actual send. |
| Medium | `relayer/src/tokengate.ts:79–81` | `inFlight.has(id) || await spentOnArkiv(id)` checks reservation before an await; concurrent redemptions can both pass. beforeWrite dedupes but endpoint admission is racy. Reserve atomically around awaited lookup. |
| Medium | `relayer/src/tokengate.ts:27,81` | `inFlight` never deletes IDs (including failed/expired requests), causing unbounded memory growth and no retry after pre-write failure. Store bounded epoch reservations and release on terminal state. |
| Medium | `relayer/src/tokengate.ts:48–69` | Cross-relayer race is detected/logged after writes; both records remain accepted by current normal readers. Need a read-time canonical rule or stronger coordination. |
| High | `relayer/src/issuer.ts:183–188` | Public GET can trigger funded publication for arbitrary app strings, bypassing issuance quota. Add app allowlist/authentication, bounds and throttling before signing. |
| Medium | `relayer/src/issuer.ts:194–198` | Issuer route buffers request body without the relayer's body limit. Bound bytes and parse/crypto work before consuming resources. |
| Medium | `sdk/src/client.ts:328–350,481–483` | Network calls lack abort deadlines; POST/status failure can bypass fresh landed-record recovery and fall through to another relayer. Add timeouts and reconcile ambiguous submission before failover. |
| Medium | `sdk/src/client.ts:138–139,281,518` | Trusted-relayer-only defaults false and final listing verification does not require creator. This contradicts AGENTS' categorical trusted-reader guidance; make trust policy explicit and authenticated. Valid derived signatures still protect content. |
| Medium | `sdk/src/proof.ts:56–73` | Verifier accepts proof-supplied chainId without comparing it to the expected network. Pass expected chain ID and reject mismatches; consider one-time challenge consumption at service layer. |
| Medium | `sdk/src/client.ts:522`; `sdk/src/seal.ts:1–7` | Working-tree enc=2 returns sealed bytes through myEntities, while comments promise no key exists after expiry. Prior readers/keepers can retain plaintext/shares; weaken the guarantee and finish client integration. |
| Medium | `apps/demo/src/store-private.ts:19–24`; `sdk/src/check.ts` `checkRecord` | Private ownership does not encrypt content and heuristic checks do not enforce no-personal-data. Explicit synthetic-only demo and encryption/schema policy needed. |

This is a bounded source audit, not a cryptographic audit or a claim that the existing test suite passes. Large UI/style files and all dependency internals were not exhaustively audited. No existing source fixes were made as part of this request.

Funded Phase 2 follow-up: separate Semaphore + Arkiv experiments now pass end to end on Tiramisu, including readonly groups/members, historical roots, ownership transfer, malicious-post rejection and proof-gated HTTP writes. See `ZK_FEASIBILITY.md` and `spikes/s3-arkiv/funded-summary.json`. This does not change the Phase 1 feature table: Semaphore is still missing from the existing `packages/sdk` / `packages/relayer` implementation, and existing application tests were not executed.

The subsequent risk follow-up found additional defects in the **new research prototypes**, detailed in `ZK_RISK_TESTS.md`: malformed JSON crashes the S5 process, invalid existing proofs preempt valid admission, volatile uncertain reservations disappear across restart, owner deletion changes current-state canonical dedupe, and two independent relayers both write a nullifier. These are observed spike findings; they are not presented as new runtime test results for the existing Veil implementation. The original source audit and preserved user edits remain unchanged.

After the user excluded ZK Email, new isolated mitigation code in `spikes/risk-hardening` passed 45 local/live/audit/expiry assertions addressing those prototype defects. See the latest section of `ZK_RISK_TESTS.md`. This does not change the Phase 1 feature classification or establish a passing production test suite: existing Veil source was neither modified nor executed.
