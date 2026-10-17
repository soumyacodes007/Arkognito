# Veil ZK feasibility — measured experiments

**Subsequent integration:** after checkpoint commit `2c53487`, the user authorized integrating and
testing the existing application. The optional Semaphore SDK/relayer module is now implemented;
see [guide](docs/semaphore.md) and [integration validation](docs/semaphore-validation.md). The
spike results and "not integrated" statements below are retained as historical evidence.

17 October 2026 (IST). Branch `zk-feasibility`, baseline `6123164`. The existing application was audited by reading only; it was never run, installed, built or tested. New experiments live under `spikes/s1-*` through `spikes/s8-*`, each with a separate exact-version manifest/lockfile. No existing signing key was used. A fresh testnet key was generated only in gitignored `spikes/.env`. No push or commit was made.

**Recommendation: build a single-relayer Semaphore membership MVP with admin-approved synthetic members; defer proof-based joining.** Semaphore, browser proving, virtual passkey PRF and Anon Aadhaar test proving work. After the user funded the fresh test account with **10 testnet GLM**, the live Arkiv group/post, readonly, historical root, ownership-transfer, adversarial-reader and HTTP-relayer tests passed on Node **22.23.3**. Follow-up risk tests then demonstrated invalid-nullifier preemption, a malformed-input process crash, loss of uncertain reservations on restart, deletion changing the canonical duplicate, and duplicate admission by two relayers. These findings require fixes before integration is accepted. See [ZK_RISK_TESTS.md](ZK_RISK_TESTS.md) for measurements and exact failures. The architecture is feasible; the research endpoint is not production ready.

**Latest result after excluding ZK Email:** the corrective `spikes/risk-hardening` experiments passed **45 assertions: 24 local, 11 live, 5 independent history-audit and 5 expiry checks**. Valid-only nullifier admission, malformed-input handling, durable pending reservations, shared-coordinator races, chronological receipt order, deletion/expiry retention and typed unavailable verification all passed their stated controls. These are new isolated mitigation implementations; original S4/S5 failures below are preserved, and actual Veil integration remains undone. See [tested mitigations](ZK_RISK_TESTS.md#tested-mitigations-after-excluding-zk-email). Latest 9 transactions cost **0.001873230003746460 testnet GLM**; cumulative 29-transaction fees **0.025600036051200072 GLM**, combined fresh-wallet ending balance **9.974399963948799928 GLM**. No additional funding or ZK Email execution was needed.

## Results

GO means the stated spike boundary passed, not that the production upgrade is complete. RISKY includes successful local components with unresolved dependencies or demonstrated correctness defects. Initial S1–S8 active runs stayed within their recorded 45-minute budgets; the funding blocker was recorded, then S3–S5 resumed after user funding. The later local ZK Email fallback was interrupted by a user-reported restart; its exact native-process stop time was not captured, so a 45-minute shutdown across that interruption cannot be certified. No full ZK Email proof was obtained. Timings below are individual observed runs, not statistical benchmarks; cache state, machine load and network matter. Windows host default Node was `24.13.1`; S1 and funded S3–S5 used isolated Node `22.23.3` to check the repository's target major.

`Semaphore` below means identity/group/proof **4.14.4**. Arkiv means **@arkiv-network/sdk 0.8.1 + viem 2.57.4**. Each row identifies its actual evidence file.

| Spike | Verdict | Measured result | Exact versions | Blocker / limit |
|---|---|---|---|---|
| S1 Node Semaphore | **GO** | Five random-secret members, depth 3; deterministic identity reproduced. Node 24 first proof **3,806.43 ms**, verify **31.05 ms**, JSON **962 B**; localhost artifacts proof **567.18 ms**. Node 22 cached default-artifact proof **956.42 ms**, verify **22.59 ms**, JSON **968 B**; localhost artifacts **301.74 ms**, verified. Fake points/message/scope rejected; outsider proving errored. | Semaphore 4.14.4; snarkjs 0.7.5; @zk-kit/artifacts 2.0.1; Node 24.13.1 / 22.23.3 | Both Node and self-hosting passed. Depth 3 is a small fixture, not a large-group benchmark. [Node 22 result](spikes/s1-semaphore-node/result.json), [Node 24 result](spikes/s1-semaphore-node/node24-result.json). |
| S2 Browser Semaphore | **GO** | Headless Chrome, Vite page: remote artifacts proof **5,364.30 ms**, verify **27.10 ms**, JSON **897 B**. Same-origin artifacts proof **350.50 ms**, verify **20.40 ms**, JSON **896 B**. Both valid, deterministic identity passed. `crossOriginIsolated=false`. | Semaphore 4.14.4; Vite 8.3.4; Playwright 1.64.1; Chrome 154.0.8037.100; driver Node 24.13.1 | Playwright's bundled executable was absent; used installed Chrome's Chromium engine headlessly, with a fresh automation context. No mobile/Safari/Firefox measurement. [Result](spikes/s2-semaphore-browser/result.json). |
| S3 Arkiv round trip | **GO — live** | Readonly rules + **5** admin-written members created at block **684940** in **8,450.81 ms**. Added member 6; old snapshot still returned 5, current state 6. Rebuilt old root matched the generated proof. Readonly patch rejected, owner transfer and nullifier query passed. Actual post payload **1,331 B**, proof **1,038 B**, **6** attributes, longest name **9 B**, longest string **77 B**. | Arkiv 0.8.1; viem 2.57.4; Semaphore 4.14.4; Node 22.23.3 | Original unfunded failure retained separately. The first funded harness misclassified the readonly error wording; read-only reconciliation confirmed rejection and unchanged data without resending. [Funded result](spikes/s3-arkiv/result.json), [original failure](spikes/s3-arkiv/unfunded-result.json), [earlier historical read](spikes/s3-arkiv/historical-result.json). |
| S4 Verify on read | **GO for adversarial proof checks; RISKY retention** | Wrote fake proof, duplicate, non-member and content-edited posts in one transaction: **5,577.77 ms**. Independent RPC read + historical root reconstruction + verification took **7,806.08 ms**: exactly **1 valid accepted / 4 rejected**. Follow-up pinned **200+5** member pagination and live same-block tie-break passed. Deleting the canonical readonly post promoted a duplicate. | Semaphore 4.14.4; Arkiv 0.8.1; viem 2.57.4; Node 22.23.3 live / 24.13.1 local | Earliest-ever wins requires retained verified history. `(block,key)` ordering is deterministic but not chronological within a block. Long-term archive SLA remains unknown. [Live result](spikes/s4-verify-read/live-result.json), [reader](spikes/s4-verify-read/read-posts.mjs), [risk follow-up](ZK_RISK_TESTS.md). |
| S5 Proof-gated relayer | **GO for live round trip; RISKY correctness** | Real HTTP: changed message **400** (`Content hash mismatch`); valid proof → create + ownership transfer **201** in **13,250.25 ms**; confirmed replay **409**. Follow-up: invalid earlier proof blocks valid nullifier; JSON `null` crashes process; volatile uncertainty lost on actual process restart; both independent relayers wrote one nullifier. Narrow durable-journal restart control passed. | Semaphore 4.14.4; Arkiv 0.8.1; viem 2.57.4; Node 22.23.3 live / 24.13.1 local; built-in node:http | Isolated prototype, not existing Veil integration. Fix validation, verified spent-history and durable admission; use one relayer for MVP. [Live result](spikes/s5-relayer/live-result.json), [server](spikes/s5-relayer/server.mjs), [risk evidence](ZK_RISK_TESTS.md). |
| S6 ZK Email | **RISKY / incomplete** | Historical company-domain DKIM passed with the **10th archived matching key**, **12.51 ms**. Registry list/slug **HTTP 500**, dev example `fetch failed`. Bare circuit initially compiled in **209,502.37 ms**, then witness hit `Num2Bits` assertion. Buffered retry emitted **1,164,357 constraints**; WASM compile stopped after ~15 min. Native fallback interrupted with no captured exit/completion. Setup artifact **2,416,002,200 B** downloaded/checksummed in **201,640.47 ms**. **No ZK Email proof generated; proving time unknown.** | @zk-email/sdk **2.0.11**, helpers **6.4.2**; circuits **6.3.4**, circom2 npm **0.2.23**, native Circom **2.2.3**, snarkjs **0.7.6**; Node 24.13.1 initial / 22.23.3 follow-up | No employment blueprint, corrected witness or credential-joining proof established. User-reported restart interrupted the native run; exit code/stop time unknown. OOM not diagnosed. Bare DKIM does not establish employment, trusted domain/key policy, freshness or commitment binding. [Initial result](spikes/s6-zk-email/result.json), [archived-key results](spikes/s6-zk-email/deep-result.json), [local fallback](ZK_RISK_TESTS.md). |
| S7 Anon Aadhaar test mode | **GO for synthetic test proving** | Official public test QR/certificate; args **15.18 ms**; proof including downloads **183,300.44 ms**; measured proving stage **39,314.65 ms**; verify **870.09 ms**; JSON **2,038 B**. Test public-key hash matched; production verification rejected test key. All optional reveal flags **0**. | @anon-aadhaar/core **2.4.3**, @anon-aadhaar/react **2.4.3**, snarkjs **0.7.6**; Node 24.13.1; artifacts v2.0.0 | WASM **10,469,686 B**, proving key **612,082,146 B**, VK **4,388 B**; substantial download/memory budget. Browser/mobile integration and Semaphore joining were not tested. [Result](spikes/s7-anon-aadhaar/result.json). |
| S8 Passkey PRF | **GO for virtual authenticator** | CDP CTAP2.1 `hasPrf=true`: creation **5.20 ms**, assertion **4.10 ms**; creation returned PRF, assertion returned **32 B**, same salt reproduced output, changed salt changed output. | Playwright **1.64.1**; Chrome **154.0.8037.100**; Node 24.13.1 | Tested headlessly on localhost with a virtual authenticator. Physical hardware, synced passkeys and recovery behavior remain untested. First IP-origin attempt failed `SecurityError: This is an invalid domain.`; localhost fixed it. [Result](spikes/s8-passkey-prf/result.json). |

## Funded follow-up and exact failures

The balances in the original five-transaction run below are historical snapshots. Subsequent risk tests added **0.0221317500442635 testnet GLM** of receipt fees. Across all **20** recorded transactions, total gas fees were **0.023726806047453612 GLM** and the two fresh test wallets' combined ending balance was **9.976273193952546388 GLM**. The 0.01 GLM transfer between those wallets is not counted as a fee. See [risk-test receipts and reconciliation](ZK_RISK_TESTS.md). No chain writes were repeated after the restart.

The funding blocker was resolved by the user on 17 October. Five confirmed transactions created **13 synthetic entities** in project `veil-zk-spike-1792219639456`: one group, six member entities and six post entities. The final independent scan accepted the two posts with different valid member nullifiers and rejected the same four malformed/duplicate posts. All five receipts have the fresh test account as sender. Total gas cost: **0.001595056003190112 testnet GLM**; remaining balance: **9.998404943996809888 GLM**. Balance reduction exactly matches the confirmed receipt fees. No additional funds are needed for these completed checks. [Final independent readback and fee reconciliation](spikes/s3-arkiv/funded-summary.json).

| Operation | Confirmed transaction |
|---|---|
| Group + five members | `0xb99bf1201cd8deffd73da706ddbbdf1ae4e7e414524792ea34b82864b203efe6` |
| Append sixth member | `0x1a247fb01261c368975136b1673216efe1998fa066a774d209bdd8f6e98cbf1d` |
| Valid proof post + transfer | `0x415c5b1d245e3f42ee89cd92ff556196cb534929c5d54fe055f37957b5c4efb9` |
| Four adversarial post fixtures | `0x2efac2c06be22d21320a8761e8b142b6063ec61b4f31a7ccaeb17a526d60ee34` |
| HTTP relay post + transfer | `0x9f15b3a7b2fa0a49a9002a2826d0ad1de46166c118fc776c3c25386b49571e7e` |

The readonly negative test returned this exact SDK error:

```text
Transaction failed: entity 0x1d4de4c0…8a4cc2 was created readonly, so its contents can never change. Its expiry can still be extended, and it can be transferred or deleted
```

The initial harness regex `/read.only/` required a separator and incorrectly marked the expected `readonly` rejection as a failed check. It was corrected to `/read.?only/`; `reconcile.mjs` authenticated all S3 receipts, reread the unchanged readonly rules, and independently verified the valid post. No writes were repeated to correct this harness bug. The initially misclassified result is retained as `funded-attempt-1.json`.

Historical initial failure before funding — S3's original batch attempt:

```text
EntityMutationError: Transaction failed: Execution error without revert data
```

S5 returned HTTP 503 with `Transaction failed: Execution error without revert data`. The guarded diagnostic blocked signing and every send method, then observed these real RPC responses:

```text
eth_fillTransaction: -32601
The method "eth_fillTransaction" does not exist / is not available.
details: the method eth_fillTransaction does not exist/is not available

eth_estimateGas: -32003, TransactionRejectedRpcError
Transaction creation failed.
details: out of gas: gas required exceeds: 0
```

viem continued past the optional unsupported method to estimation. The diagnostic method list ended at `eth_estimateGas`; it did not reach a signing/send barrier. The original uninstrumented errors are not evidence of mined reverts. No automatic resubmission was performed after those failures. The cause-chain masking issue was appended to `arkiv/friction.md` with a guarded reproducer. Public faucet GET returned **401 `{"error":"Unauthorized"}`**; the Hub UI showed “Sign in with your wallet to claim testnet $GLM,” and the served faucet code included a CAPTCHA-gated claim flow. No existing relayer wallet was used as a funder and no CAPTCHA was bypassed.

S6 exact verification failures:

```text
DKIM signature verification failed for domain bf01.eu1.hubspotstarter.net. Reason: bad signature
DKIM signature verification failed for domain starknet.org. Reason: bad signature
Error: HTTP error! status: 500
```

The SDK's default registry base is `https://conductor.zk.email`; `listBlueprints({limit:5})` calls its `/blueprint` endpoint. This was a real request, not a guessed endpoint. The SDK import also printed `WARNING: Missing strong random number source`; no proof was generated with that SDK path, so its randomness suitability is not established. Helpers printed `DKIM record mismatch between Google and Cloudflare! Using Google result.` The initial key-rotation explanation was subsequently tested: with the same public fixture, a custom resolver trying archived matching-selector keys obtained a valid signature/body-hash check on the **10th** `hs2` key for `bf01.eu1.hubspotstarter.net` (**12.51 ms** for the successful check); the previous nine failed. No archived matching selector was found for `starknet.org`. Default Registry list and documented slug still returned **HTTP 500**; the official development example returned `fetch failed`. This is DKIM signature evidence, not a credential ZK proof. See `spikes/s6-zk-email/deep-result.json` and the local-circuit follow-up in [ZK_RISK_TESTS.md](ZK_RISK_TESTS.md).

S7's first attempt passed an arbitrary text `signal`; it failed exactly:

```text
invalid BigNumber string (argument="value", value="synthetic-veil-join", code=INVALID_ARGUMENT, version=bignumber/5.7.0)
```

The final attempt passed the SHA-256 digest as numeric `0x` hex, as required by the installed hash helper, then generated/verified the proof. `verify(proof, false)` correctly threw **`VerificationError: public key mismatch.`** The failed first attempt is saved separately. These errors do not imply the final proof failed.

S2/S8's initial default launcher error was `browserType.launch: Executable doesn't exist at C:\Users\soumy\AppData\Local\ms-playwright\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe`; explicit installed Chrome worked. S2 also logged a single resource 404 (the page has no favicon); it did not prevent proof generation.

## Artifacts, browser behavior and identity

`new Identity(randomBytes(32))` reproduced the same commitment for the same 32 secret bytes. Use high-entropy, domain-separated secret derivation, not an email, Aadhaar number or predictable password. A Semaphore commitment here commits to a random synthetic secret; it is not a personal-data hash. Public roots/nullifiers disclose group and scope participation, even though they do not disclose which member posted.

Proof package **4.14.4** explicitly requests **artifact version 4.13.0**; these version numbers differ intentionally in installed source. Depth-3 defaults were fetched from:

* `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.wasm` — **1,802,902 B**, SHA-256 `48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2`.
* `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.zkey` — **1,899,542 B**, SHA-256 `c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3`.

In Node, `@zk-kit/artifacts` caches default files under the OS temp directory (`snark-artifacts/semaphore/4.13.0/`). In the browser it supplies remote URLs. Both paths worked. Self-hosting was actually tested by serving copies at a local HTTP origin: Node downloaded them and passed Uint8Arrays, browser passed same-origin URL strings as the sixth argument:

```js
await generateProof(identity, group, message, scope, 3, { wasm, zkey })
```

`verifyProof` uses bundled verification keys and did not require downloading proving artifacts. Files/OS-temp caching and Node's Buffer/fs/http were specific to the Node harness; the browser proof path used Web Crypto and URLs without those APIs. These tests do not benchmark large trees or mobile devices. Pin artifacts and trusted digests in a deployment rather than relying on an unpinned CDN “latest.”

## Reader and relayer design decisions

Follow-up implementation note: `risk-hardening/hardened.mjs` now demonstrates the fixes discussed here. The retained-history reader uses authenticated native event positions instead of lexical key ties, preserves spent status after deletion and expiry, and raises typed unavailability rather than rejecting a valid post as invalid on provider failure. Participating relayers share a durable single-host admission journal. Independent receipt/readonly verification is in `risk-hardening/audit-history.mjs`. These controls passed; distributed coordination, complete production recovery and integration into Veil have not been established.

The implemented `readPosts(group, scope, store)` pins the post enumeration snapshot; the Arkiv adapter scopes rules/members to the admin and posts to configured trusted relayers, uses inline selections, `.atBlock(block)` and all-page iteration, and sorts member indexes in JavaScript. It requires contiguous unique indexes, unique commitments and readonly memberships/rules. It rebuilds the historical root and checks proof depth, scope, group, message, content owner, rootBlock and matching indexed proof fields. Invalid earlier posts do not reserve a nullifier. Valid duplicates are ordered by creation block and then ascending entity key.

These are material additions to the proposed plan:

1. **Scope must include group and protocol/network domain**, in addition to the time window. Reusing one numeric window across groups makes a member's Semaphore nullifier repeat across those groups. `windowScope` hashes `[protocol, chainId, group, window]`.
2. **Hash the complete immutable content**, including protocol version, chain ID, group, scope, rootBlock and destination owner. Hashing only message text lets a relayer redirect ownership or substitute metadata without changing the proven text. This spike uses a fixed ordered serialization and rejects unexpected content keys.
3. **“Earliest” needs a defined same-block rule.** Arkiv creation blocks cannot tell transaction order within a block. This prototype uses ascending key order; it is deterministic but does not claim actual earliest transaction. Strict transaction ordering would need authenticated transaction/log positions and additional indexing.
4. **Readonly does not mean undeletable.** Owner deletion, expiry and historical-provider retention affect replay detection and root reconstruction. To keep an earliest-wins promise across deletions/expiry, maintain a defined retained history/spent-marker policy covering the scope and post lifetime. Live current-state queries alone cannot prove global first use forever.
5. **No on-chain verifier or global atomic nullifier guard exists here.** A relayer can admit or censor; readers remain the acceptance authority. The local endpoint serializes admission/write for one wallet and retains reservations after uncertain failures, but has no persistent replay database or multi-relayer consensus. A malicious earlier marker must not suppress an otherwise valid post merely by copying a nullifier.
6. Cache successfully authenticated `(group, rootBlock, depth)` roots and immutable rules. Bound pages, proof depths, request bytes and CPU work; the research endpoint's body limit and queue are not full production DoS controls. The follow-up hit real HTTP 429 `ANON_COST_LIMITED`; server-side authenticated RPC access recovered the run. The separate local failure injection also showed `readPosts` returns historical-provider failure as a rejected candidate instead of typed unavailable/incomplete verification. Fix that distinction. Historical snapshots around 190,000 blocks back were observed; provider retention still has no established SLA.

The funded workflows in S3, S4 `live.mjs` and S5 `live.mjs` have now run successfully: readonly groups/members, appended membership, historical root reconstruction, nullifier lookup, malformed posts and proof-gated create/transfer all passed. The independent final scan verified both valid posts against the original five-member snapshot after the sixth member had been added. The measured post includes content/group/scope/rootBlock/owner binding. These are small, synthetic end-to-end experiments; none changes the existing Veil implementation.

## Joining stretch goals

The current ZK Email flow is blueprint definition (DKIM sender domain, signed headers/body constraints, regex visibility and explicit external inputs), authenticated submission/compilation in the Registry, fetching a compiled blueprint, then `createProver({isLocal:true})`, `generateProof`, and `verifyProof`. Proving remotely sends the email to that prover; a private local prover is needed for the intended privacy claim. Signed company domain alone proves control of a signing domain, not employment or a valid relieving letter. The exact signed statement, recipient binding, freshness, revocation and subject-to-Semaphore commitment binding need a circuit/policy. Do not skip body hashing when proving employment text in a body. [Official SDK flow](https://github.com/zkemail/zk-email-sdk-js), [blueprint guide](https://docs.zk.email/zk-email-sdk/create-blueprint).

Anon Aadhaar 2.4.3 can reveal **age above 18, gender, state and PIN code**; these optional outputs were all disabled in the measured test. Other public signals still include signer-key hash, timestamp, nullifier, nullifier seed and signal hash. Its circuit computes a nullifier from **seed and hashes of packed photo data**; it is not a fresh random token. An application must fix/domain-separate the seed and bind the signal to the intended membership commitment; a user-selected seed defeats per-application deduplication. Production verification also needs freshness and the expected public-key hash, beyond raw Groth16 validity. [Official core](https://github.com/anon-aadhaar/anon-aadhaar/tree/main/packages/core), [nullifier circuit](https://github.com/anon-aadhaar/anon-aadhaar/blob/main/packages/circuits/src/helpers/nullifier.circom), [test-mode/reveal docs](https://documentation.anon-aadhaar.pse.dev/docs/quick-setup).

**Keep joining credentials, raw emails/QRs, attester data and personal-data-derived outputs off Arkiv.** In particular, a real Aadhaar photo-derived nullifier would fall under the repository's ban on hashed personal data. A viable demo would verify a synthetic joining proof privately/off chain, then publish only a random-secret Semaphore commitment via the admin. Do not write email hashes, Aadhaar nullifiers, extracted personal fields or mappings from credentials/main wallets to commitments/derived owners. No such data was written by these spikes.

## Scope that fits 1.5 days

The full plan — production Semaphore integration, distributed replay handling, ZK Email employment circuits, Anon Aadhaar joining, cross-device passkey UX and hardened operations — **does not fit 1.5 days**. The ordered plan below is **13.5 focused working hours**, spread over 1.5 nine-hour workdays, with one relayer and synthetic admin-approved members. After the risk follow-up this is a tight prototype budget, not a production-hardening promise: prioritize the demonstrated admission/history defects over optional demo work. The isolated funded gate has passed; the actual integration gate still needs to pass.

1. **1.0 h — Freeze the protocol around the passed live spikes.** Canonical content, group/window scope, depth and tie-break policy. Turn the funded S3/S4/S5 evidence into a repeatable gate for the actual SDK integration. Gate: rules/members/post readback, readonly rejection, transferred owner, historical root, nullifier lookup and adversarial rejection. Funding and isolated feasibility are already established; this hour is for specification and integration acceptance criteria.
2. **1.5 h — Address the existing relayer's critical static findings.** Authenticate spent-history sources, preserve minimum anonymity after rejection/splitting, and reconcile uncertain writes before resubmission. Gate: focused failure/race regressions for those invariants. Avoid sweeping unrelated refactors.
3. **2.0 h — Add an admin-only group writer and historical loader.** Readonly rules and members, monotonic index, trusted creator, pinned pagination and root cache. Gate: append a member and prove old/new snapshot roots differ correctly.
4. **1.5 h — Integrate Semaphore identity and browser proving.** Domain-separated secret input, pinned self-hosted artifacts, proof/content/owner binding. Gate: browser proof verifies, wrong scope/owner/message fails, no root/signature/identity secret reaches Arkiv.
5. **2.0 h — Integrate verified reads into the SDK.** Historical root, depth and scope checks, earliest valid dedupe, complete paging and explicit unavailable-history error. Gate: all five malicious/valid cases on Tiramisu, plus an invalid earlier post and same-block tie.
6. **2.0 h — Add one proof-gated relayer path.** One wallet/queue, durable per-scope reservations, bounded proof work, atomic create/transfer, verified spent-history retention and restart reconciliation. Fix the research endpoint's malformed-input crash and invalid-proof preemption before reuse. Gate: invalid earlier proof cannot spend a nullifier; deletion cannot release it; `null` request returns 400; concurrent duplicate gets one accepted write; message/owner tampering fails; actual process restart does not replay. If this exceeds the allocation, use the 1.5 h buffer and cut demo paths.
7. **1.0 h — Connect the existing minimal demo.** One synthetic admin group and anonymous post/read flow; preserve existing ownership API and clearly separate membership proof from ownership proof. Gate: browser → relay → Arkiv → independent reader succeeds with synthetic data only. No UI polish.
8. **1.0 h — Document and package.** Update SPEC/schema/README with trust/retention/tie rules, measured limits, exact versions and failures. Gate: a clean isolated install on Node 22 and a reproducible funded walkthrough; review final data/secret diff.
9. **1.5 h — Buffer for integration errors.** Cut optional demo paths if consumed; do not postpone the live adversarial gate.

Total: **13.5 h**. Cut ZK Email, Aadhaar joining, multi-relayer consensus, new passkey UX, custom circuits, large-group optimization and sealed-expiry work from this deadline. S7's success is useful future evidence, not justification to add credential joining to this MVP. Preserve existing blind tokens until the single-relayer Semaphore path has passed the actual live gates; existing application functionality was not retested here.

## Reproduction, dependency review and remaining evidence

See [spikes/README.md](spikes/README.md) for commands and dependency order. Every experiment has an exact-version lockfile. Installed dependency audits reported advisories; saved `npm-audit.json` files are point-in-time machine output, not an exploit assessment. S1: **13** (4 moderate, 9 high). Initial S3 before adding Semaphore proof dependencies: **5** (4 moderate, 1 high); expanded install reported **13**. S6: **23** (12 low, 2 moderate, 9 high). Saved S7 audit: **25** (13 low, 3 moderate, 9 high); installation initially reported 24. No automatic dependency fixes were applied. Anon Aadhaar React also emitted a React 18 vs react-qr-reader React 16/17 peer warning. These isolated dependencies do not change the root lockfile.

Follow-up evidence now covers **205** live member records over two pinned pages, Semaphore groups up to **65,536** leaves, live same-block duplicates, owner deletion, expiry/historical retrieval, actual process restarts, a narrow durable-admission guard, and a real two-wallet relayer race. See [ZK_RISK_TESTS.md](ZK_RISK_TESTS.md). These tests found defects rather than certifying production replay correctness. Remaining unverified: integration into the existing SDK/relayer/demo, complete durable transaction coordination, long-term archive availability, physical authenticators, physical mobile proving, and any production credential joining. No ZK verifier contract was deployed or proposed for Arkiv; verification runs in readers and the HTTP service.

Initial file verification: all **17 then-existing JavaScript modules** passed `node --check`; the funded follow-up added read-only reconciliation/summary modules and checked the changed scripts separately. `git diff --check` passed; `git check-ignore spikes/.env` confirmed the fresh signing-key file is excluded. Runtime success is evidenced by the recorded funded receipts and independent readback, not syntax checks. Existing user edits remained present and the root manifests/lockfile were not changed.

Final risk-follow-up checks: **34** isolated JavaScript modules passed `node --check`; **63** public JSON files parsed successfully using PowerShell `ConvertFrom-Json -AsHashtable`. The first validation attempt used the object converter and rejected npm lockfiles with exact error `The provided JSON includes a property whose name is an empty string, this is only supported using the -AsHashTable switch.` This was a validation-harness limitation, corrected without modifying the lockfiles. A value-comparison scan of **109** public untracked files found no fresh spike signing key or configured RPC access key. Ignored witness/journal/compiler paths remained excluded; root package manifests/lockfile were unchanged and `git diff --check` passed. Native compiler and driver were absent on resumption; no additional heavy proving test was launched. The runner's new timeout/logging/thread settings received syntax checks only, not a fresh proving run.
