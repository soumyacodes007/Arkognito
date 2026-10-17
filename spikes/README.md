# Isolated feasibility experiments

Latest non-email follow-up: `risk-hardening` contains corrective controls, with **45 passing assertions** across local, real Tiramisu, independent read-only audit and expiry tests. See `risk-hardening/README.md` and `ZK_RISK_TESTS.md#tested-mitigations-after-excluding-zk-email`. Original failing spikes remain preserved. ZK Email was excluded by the user and was not run again.

These experiments never import `packages/`, `apps/`, the published `arkognito` package, or existing test helpers. Each S1–S8 directory has its own manifest and lockfile; installs were made with `npm install --prefix spikes/<directory> --save-exact ...`. No root workspace install/build/test was run. Read the root `VEIL_AUDIT.md` and `ZK_FEASIBILITY.md` for measured results. After user funding, S3–S5 all passed against Tiramisu; initial unfunded failures remain recorded.

Results are retained as JSON next to the scripts. Signing material lives only in gitignored `spikes/.env`; the preflight creates a fresh key if needed and prints only its address. Do not commit this file. No existing wallet key is used. During the risk follow-up only, `risk-state/rpc-options.mjs` reads the existing root `.env` RPC access key for server-side `X-API-KEY` headers after anonymous queries hit HTTP 429. It never prints that key or imports an existing signer. Public email/Aadhaar fixtures never go to Arkiv. The local email fallback stores witness/artifacts only under ignored `state/`; other fixture checks use memory. Ignored proving artifacts can be downloaded again.

From the repository root in PowerShell:

```powershell
# Install only the selected experiment's pinned dependencies, for example:
npm ci --prefix spikes/s1-semaphore-node
npm ci --prefix spikes/s2-semaphore-browser

# Primary Node 22 run (the runtime is an exact devDependency of S1):
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/s1-semaphore-node/run.mjs
node spikes/s2-semaphore-browser/run.mjs
node spikes/s3-arkiv/preflight.mjs
node spikes/s3-arkiv/historical-read.mjs
node spikes/s3-arkiv/diagnose-write.mjs # signing/send barriers; never broadcasts
node spikes/s4-verify-read/run.mjs    # local adapter, real proofs
node spikes/s5-relayer/run.mjs        # local HTTP tests; unfunded diagnostic only, funded write skipped
node spikes/s6-zk-email/run.mjs
node spikes/s6-zk-email/control-dkim.mjs
node spikes/s7-anon-aadhaar/run.mjs
node spikes/s8-passkey-prf/run.mjs
```

S2/S8 use installed Chrome headlessly if Playwright's bundled Chromium is absent. They do not use the user's browser profile. S8 must run on `localhost`, not an IP relying-party domain.

The first S3 batch attempt failed on the fresh wallet's zero balance. The user then funded that account with 10 testnet GLM; the expanded live workflows below **passed on Node 22.23.3**. Five confirmed transactions consumed 0.001595056003190112 testnet GLM. `s3-arkiv/funded-summary.json` records receipts, final independent verification and the remaining balance. Do not run these alongside another process using this wallet. No automated resend after an ambiguous write is implemented. Preserve hashes/results and reconcile before rerunning. Repeated S3 invocations create new synthetic groups and consume more test GLM.

```powershell
node spikes/s3-arkiv/run.mjs
# Only after S3 completes successfully and creates live.json:
node spikes/s4-verify-read/live.mjs
node spikes/s5-relayer/live.mjs
# Independent, read-only final verification and fee reconciliation:
node spikes/s3-arkiv/funded-summary.mjs
```

The funded workflow writes short-lived, synthetic rules/members/posts and deliberately malformed proof posts, all under a unique spike project. S4/S5 expect S3's group in `live.json`. S5 accepts only the current UTC hour scope; rerun S3 with a fresh scope if that fixture has become stale. A `live.json` file is not proof of success by itself: inspect actual receipts/readback and result verdicts. Readonly does not prohibit owner deletion, transfer, or extension.

S3 `unfunded-result.json` retains the original failed attempt; `result.json` now contains funded success. `funded-attempt-1.json` preserves the initial funded result whose readonly rejection was misclassified by a test regex; `reconcile.mjs` corrected it through receipt/data readback without resending. S4/S5 `result.json` retain initial local/unfunded evidence; `live-result.json` contains actual successful live runs. Do not label local adapter success as a chain round trip. Initial S1–S8 active runs and funded follow-ups stayed within their recorded budgets. The later local ZK Email fallback was interrupted by a user-reported restart; exact native-process stop time and timed shutdown could not be established. See `ZK_RISK_TESTS.md` for the limitation.

The scripts are research scaffolding, not production endpoints: no persistent multi-process replay database, provider-retention SLA, authentication service, CPU work budget, or distributed relayer consensus is claimed. Same-block key order is an explicit tie-break policy, not transaction ordering.

Risk follow-ups are documented in `ZK_RISK_TESTS.md`. Each `risk-*` directory has its own manifest/lockfile. Install only the selected directory, using `npm ci --prefix spikes/risk-scale` (or `risk-state` / `risk-email-local`). Use the isolated Node 22 executable from S1 for these scripts:

```powershell
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-scale/run.mjs
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-scale/browser.mjs
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/s6-zk-email/deep.mjs
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' --max-old-space-size=6144 spikes/risk-email-local/run.mjs
# LIVE writes: run individually, with exclusive custody of the fresh spike wallets.
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-state/run.mjs
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-state/durability-and-race.mjs
```

`risk-state/run.mjs` creates a new 205-member group and writes/deletes synthetic posts. `durability-and-race.mjs` creates a fresh three-member group and funds a second fresh spike wallet; two distinct wallets race, with only one writer per wallet. These reruns spend test GLM and create new fixtures. Preserve old results before rerunning. `resume.mjs` was a specific recovery from the saved anonymous-quota failure, reusing the ignored `state/durability-fixture.json` and reconciling its confirmed hashes; it is not a generic repeatable runner and will refuse an already-written fixture. `race-rate-limited-attempt.json` preserves the failed run and `race-result.json` contains the successful resumed tests. `durable-child.mjs` tests a narrow persisted-admission guard with failure injection and no broadcast; it is not a production database or complete transaction-recovery service. The S5 server intentionally remains the tested research prototype with its reported defects.

`risk-state/read-availability.mjs` reuses that same local fixture, injects a historical-provider failure, and records how the prototype reader classifies it. It performs no RPC requests, signing or broadcast. None of these controls changes the existing SDK or claims that production recovery is implemented.

`risk-email-local` did **not** generate a successful ZK proof. Preserve `initial-witness-error.json`, `wasm-retry-stopped.json`, `native-interrupted-result.json` and finalized `result.json`. `artifact-check.mjs` checks the official README's power-21 links; `download-ptau.mjs` retrieved the current 2.42 GB mirror and verified its BLAKE2b-512 hash. The installed README's Google Storage link returned 403. Native compiler 2.2.3 came from the official iden3/circom release; SHA-256 `e43f132ee6f0aa79b705beceb59c2a7e6a54d7bdeab917ca34e9fc1951d185e1` matched the release digest. The optional `--native` flag expects that executable at ignored `state/circom.exe`. The original native result ended at compile; the user reported a restart, while the native exit code and exact stop time remain unknown. On resumption neither compiler nor driver was running. Afterward the runner was edited to log the child PID/output immediately, limit compilation to five minutes, and set `RAYON_NUM_THREADS=2`; those changes received syntax checks only, with no further heavy compile/prove attempt. They do not prove resource safety or successful witness generation.
