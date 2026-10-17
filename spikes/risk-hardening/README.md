# Isolated reader/relayer mitigation controls

These scripts test corrections to the earlier research spikes. They do not import, execute or modify the existing Veil SDK, relayer or demo. ZK Email is excluded. Exact versions: Arkiv SDK 0.8.1, viem 2.57.4, Semaphore identity/group/proof 4.14.4; runtime Node 22.23.3. Installation reported 13 dependency advisories (4 moderate, 9 high); no automatic fixes were applied.

Measured results: `local-result.json` has **24** passing controls, `live-result.json` **11**, `history-audit.json` **5**, and `expiry-result.json` **5**. `local-initial-result.json` preserves the earlier 21-control run. The current `hardened.mjs` adds DTO validation, typed unavailable verification, valid-proof-only replay checks, a flushed admission journal and receipt-position-based retained-history reads. Pending admissions stay blocked until explicit reconciliation; none of these scripts automatically resends an uncertain transaction.

The child-process tests use real Semaphore proofs and deliberately exit code 77 or inject write/checkpoint failures **without broadcasting**. The live workflow uses actual Tiramisu writes and transfers between the existing fresh spike wallets. The independent audit imports no signer, verifies native creation logs against receipts and readonly creation flags, rebuilds historical roots, and checks canonical results. Expiry is a separate synthetic project so it does not change the primary live fixture.

From the repo root, run these **one at a time**; preserve existing results before rerunning:

```powershell
npm ci --prefix spikes/risk-hardening --ignore-scripts
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-hardening/local.mjs
# The following creates a new synthetic group and spends testnet GLM:
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-hardening/live.mjs
# Read-only audit of that live result:
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-hardening/audit-history.mjs
# Separate live expiry experiment; two further transactions:
& './spikes/s1-semaphore-node/node_modules/node/bin/node.exe' spikes/risk-hardening/expiry.mjs
```

Node 22 is installed as S1's exact dev dependency. Each new live invocation creates a distinct project. Never rerun a failed live invocation as a recovery mechanism: first reconcile its captured transaction hashes, receipts and application state. Signed bytes, local fixtures, locks and journals are under ignored `state/`; fresh signing keys are only in ignored `spikes/.env`. Only the existing server-side RPC access key is read from root `.env`, for `X-API-KEY` headers. No existing wallet key is used.

`live.mjs` caps admitted fee/value at 0.05 GLM; `expiry.mjs` caps admitted fees at 0.01 GLM. Measured fees were **0.001217246002434492** and **0.000655984001311968 GLM**, respectively. No new funding was needed. Native creation-event ABI and flag handling were read from the pinned SDK's published `entity/events.ts` and `entity/flags.ts` before use.

Limits: the admission journal is a trusted, single-host coordinator shared by participating relayers. Separate hosts/databases do not gain global atomic admission. A crash while holding the file lock requires explicit reconciliation; the code fails closed instead of stealing stale locks. Machine power-loss behavior, high availability and durable status/recovery APIs are not established. The retained reader requires a complete authenticated publication history, not just live query results; native event enumeration and the historical provider remain trust/availability dependencies. The `complete` argument is a caller assertion backed by the bounded ingestion audit, not a cryptographic completeness proof. This is not production Veil integration or a production hardening certification.

Final verification: all **6** hardening JavaScript modules passed `node --check`; all **7** public hardening JSON files parsed. Every one of the **45** recorded assertions was checked for `pass=true`. Nine new receipt fees reconciled with the final wallet balances. A scan of **123** public untracked files found no fresh signing key or configured RPC access key. Ignored journals/keys stayed excluded, `git diff --check` passed, root manifests were unchanged, and no hardening test process remained running. No push or commit was made.
