# Integrated Semaphore validation

17 October 2026. Branch `zk-feasibility`. Existing work was first checkpointed as `2c53487` at the
user's request. Unlike the earlier isolated spikes, these tests import and execute the actual
Arkognito SDK and relayer. Nothing was pushed, published or deployed. Only a throwaway spike wallet
signed; all records are synthetic and all transactions used Tiramisu chain 7738577.

Machine-readable public evidence: [`semaphore-validation.json`](semaphore-validation.json).
Private recovery material, raw signed transactions and admission journals stay in gitignored
`spikes/state/`; signing keys remain in gitignored `spikes/.env`. RPC access keys are used only by
the Node driver/relayer and temporary local RPC proxy, never passed to the browser.

| Check | Actual result |
|---|---|
| SDK build | `npm run build` passed; declarations, JS imports, worker URL and bundled guide emitted |
| Typecheck | `npm run typecheck` passed |
| Existing frontend production build | `npm run build -w arkognito-demo` passed |
| Offline tests on Node 22.23.3 | **46 passed, 0 failed**, including existing crypto/inbox/passkey/cover/seal tests and new Semaphore/journal/batcher tests |
| Full integrated live/browser run | **32 checks passed**, including eight receipt checks; actual SDK calls, HTTP service, browser worker and independent reader |
| Plain Node compiled imports | Root SDK and `arkognito/semaphore` exported functions imported successfully without source conditions |
| npm package dry run | 119 entries, 133,703 compressed bytes; includes compiled Semaphore module, declarations, worker and guide |
| Node full write/recovery | **23,830.97 ms**, including proof, RPC, batch transaction, injected failed acknowledgement, recovery and readback |
| Browser full write | **28,856.50 ms**, including worker proof, RPC, native transaction and decrypted readback; Chrome **154.0.8037.100** |
| Final run gas | Eight successful transactions; **0.001851494003702988 testnet GLM**, exactly reconciled against wallet balance delta |
| All integration attempts | 23 successful transactions across four attempts, total **0.005537762011075524 testnet GLM**; includes the first failed harness attempt's confirmed group |
| Temporary frontend cleanup | Both temporary test files removed; existing demo preserved |

These are individual observations, not statistical benchmarks. Browser artifacts were self-hosted
and both depth-3 SHA-256 digests matched the pinned files. The browser measurement uses a desktop
headless Chrome with a recovery-backed WorkerVault, not a physical passkey or mobile device.
Versions: Arkiv 0.8.1, viem 2.57.4, Semaphore identity/group/proof 4.14.4, Vite 8.3.4,
Playwright 1.64.1. npm installation ran under host Node 24.13.1 and warned about the Node 22 engine;
the integration and final 46-test suite ran on isolated Node 22.23.3.

## What the integration actually exercised

* Created an empty readonly group; proof snapshots refused it before minimum membership.
* Enrolled three vault-derived random commitments with contiguous admin-written indexes.
* Used the normal `createPrivateClient({ semaphore: { group } })` and `createEntity` path.
* Recovered a confirmed write after an injected failed status acknowledgement, without resending.
* Decrypted the record through `myEntities()` and generated its ordinary ownership challenge proof.
* Verified native ownership transfer and readonly creation.
* Rejected JSON null (400), replay (409), fake curve points (400), missing required membership (403)
  and owner substitution (400).
* Restored an admitted identity inside the actual browser WorkerVault, generated its proof using
  self-hosted artifacts, submitted through the real relayer and decrypted the result.
* Independently verified both Node/browser records from native logs, receipts and historical state.
* Published two valid same-nullifier fixtures in one native batch; receipt order selected the first.
* Deleted the first fixture and verified that the duplicate was not promoted.
* Appended a fourth member and confirmed the original historical membership snapshot stayed at three.
* Used direct native SDK fixtures with six-second/one-hour signed lifetimes to exercise actual
  expiration without waiting an hour; expiration retained spent state and rejected the duplicate.
  Normal Arkognito HTTP submissions still use the existing minimum one-hour expiry bucket.
* Exercised real-proof content/attribute/owner/expiry/group/scope negatives, a nonmember prover,
  malformed metadata, typed provider unavailability, and fixed/window scope separation offline.
* Exercised an actual child-process exit (code 77) after durable reservation, a new journal instance,
  corrupt/stale-locked journals, uncertain sends without split/retry, and final-batch anonymity checks.

## Failures encountered and corrected

The first live attempt created its group then stopped before posting with this exact underlying
SDK error:

```text
InvalidPredicateError: "$key" is a key, but the value is a str. System attributes have a fixed type — write key(...) around the value.
```

The integration incorrectly used an untyped string in a system-key predicate. It now uses the SDK's
`key(...)` constructor. A read-only check rebuilt the already-created group successfully before
the next integration run. This is an application mistake, not an invented Arkiv defect.

The initial journal used `Array.findLast`, outside this repo's ES2022 type target (`TS2550`). It
was replaced with `reverse().find()`. A later dynamically imported assertion needed an explicit
module type (`TS2775: Assertions require every name in the call target to be declared with an
explicit type annotation.`); adding the annotation restored clean build/typecheck.

One combined offline run failed with `AssertionError [ERR_ASSERTION]: 2 !== 1` because a new test
assumed fixed order after the batcher's cryptographic shuffle. Selecting the intended fixture by
request ID fixed the nondeterminism; the final complete suite passed. This was a test-fixture error.

## Remaining limits and warnings

* **Experimental, not security-certified.** No independent audit or physical-passkey/mobile testing
  was performed. Existing blind-token and unrelated audit findings are not all resolved by this module.
* **npm audit: 13 advisories (4 moderate, 9 high, 0 critical).** The dependency tree includes the
  upstream Semaphore/proof tooling chain. No exploitability assessment or forced downgrade was
  performed. Production dependency review remains necessary.
* The test run emitted `MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
  15 unpipe listeners added to [Socket]. MaxListeners is 10.` The source was not diagnosed. Node
  proving workers also kept an early test process alive after assertions; test scripts use Node's
  explicit `--test-force-exit`, and the opt-in integration driver exits only after cleanup/results.
* Vite warned about existing `__dirname` usage and browser-externalized `crypto` imports in HPKE/
  blind-RSA dependencies. Build and actual browser-worker flow nevertheless passed.
* Journals coordinate cooperating processes on one host. Stale locks and uncertain admissions
  need manual reconciliation; there is no automatic repair or cross-host consensus.
* Verification needs complete native logs and historical entity states. Default block/page/publication
  budgets are finite; long-lived applications need a durable authenticated index and retention policy.
* There are no production Aadhaar/email adapters, unique-person guarantees, immediate revocation,
  hidden public metadata, guaranteed secure deletion, or complete network anonymity.
