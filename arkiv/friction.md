# Arkiv friction log

Specific, reproducible feedback on Arkiv rough edges, logged the same day we hit them.

## Top-level mutation error obscures the zero-balance gas-estimation failure — 17 Oct 2026

- **SDK / network:** `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Node 24.13.1 · Tiramisu (7738577).
- **What we expected:** a create/batch attempt from a fresh unfunded test wallet should explain the funding/gas-estimation rejection in its top-level error, and distinguish a pre-send estimate failure from an uncertain broadcast outcome.
- **What happened:** S3 `executeBatch` and S5's HTTP write returned `EntityMutationError: Transaction failed: Execution error without revert data`. A separate guarded diagnostic (signing and sending both blocked) observed `eth_estimateGas` failing with code `-32003`, name `TransactionRejectedRpcError`, details `out of gas: gas required exceeds: 0`. Those details are retained down the cause chain but absent from the top-level message. The diagnostic did not reach signing or a send method. The earlier uninstrumented failures are not mined-revert evidence.
- **Steps:** create a fresh key only in gitignored `spikes/.env`; confirm chain 7738577 and zero balance; install S3's pinned dependencies; run `node spikes/s3-arkiv/diagnose-write.mjs`. It intercepts the RPC methods and blocks all signing/broadcasting, attempts a tiny synthetic create, and records the cause chain in `spikes/s3-arkiv/write-diagnostic.json`. The original batch attempt is `node spikes/s3-arkiv/run.mjs`; do not retry an uncertain funded write automatically.
- **What would fix it:** include nested `details` / `shortMessage` when a `ContractFunctionExecutionError` has no decoded entity revert; expose the observed failure phase separately from the error text. Continue preserving `cause` and any known transaction hash.
- **Workaround:** preflight balances and guarded estimates, inspect the complete cause chain, and reconcile any admitted send before retrying. Faucet GET also returned HTTP 401 `{"error":"Unauthorized"}`; Hub UI requires wallet sign-in and CAPTCHA, so the fresh-account live group/transfer tests could not be completed unattended. That access requirement is an onboarding blocker, not evidence of a chain mutation bug.
- **Funded follow-up, same day:** after the user funded the fresh test account, S3–S5 passed: readonly updates were rejected, create/transfer and historical membership worked, and the independent reader rejected all four bad-post fixtures. Five successful receipts and exact fees are recorded in `spikes/s3-arkiv/funded-summary.json`. The original zero-balance error-message issue remains reproducible on an unfunded account; it was not a funded chain failure.

Format for each entry:

```
## <short title> — <date>
SDK version · network · what we tried · what happened · what we expected · steps to reproduce · workaround
```

## Expiry hides an entity from queries but does not erase it — 9 Oct 2026

- **SDK / network:** `@arkiv-network/sdk` 0.8.1 · Tiramisu (7738577)
- **What we tried:** create an entity with `ExpirationTime.fromBlocks(10)` and a unique marker in the payload, wait until the head is past `expiresAt`, then try every way of reading it.
- **What happened:** `getEntity` throws `NoEntityFoundError` and a normal query returns nothing, as documented. But a query with `.atBlock(<creation block>)` still returns the entity with its payload, and the payload bytes are in the create transaction's calldata (`eth_getTransactionByHash`), uncompressed.
- **What we expected:** nothing in the docs says either way. "Expiry" reads like deletion to most builders, and the skill docs describe it as data that "expires".
- **Why it matters:** any app that relies on expiry for privacy ("this report disappears after 24 h") is wrong. Payload history is permanent for anyone with an archive RPC.
- **Reproduce:** `npx tsx spike/05-expiry-visibility.ts` (needs `RELAYER_1_PRIVATE_KEY` in `.env`).
- **Workaround in Arkognito:** docs say plainly that expiry limits queries, not history; anything sensitive must be encrypted client-side before it is written (PRD A6).

## `predictEntityKeys` is only valid with one batch in flight, and a stale prediction costs a failed send — 9 Oct 2026

- **SDK / network:** 0.8.1 · Tiramisu
- **What we tried:** predict keys for two batches from the same wallet before sending either (as two concurrent requests would), then send both, each transferring ownership of its predicted keys.
- **What happened:** the first batch lands. The second fails with `no entity 0x… — it may have been deleted, or have expired`, because the entity nonce moved. The revert is atomic (no half-created records left owned by the relayer), which is good.
- **What we expected:** this is documented in the `predictEntityKeys` JSDoc, but the error message points at expiry/deletion, not at a stale nonce, so it is hard to diagnose.
- **Reproduce:** `npx tsx spike/01-batch-transfer.ts`, test 2.
- **Suggestion:** an `executeBatch` option that applies ownership changes to "the n-th create of this batch" instead of to a precomputed key would remove the race entirely.
- **Workaround in Arkognito:** one writer queue per relayer wallet; predict immediately before sending; on this error, re-predict and resend.

## Node rejects uppercase attribute names that the SDK and docs allow — 9 Oct 2026

- **SDK / network:** 0.8.1 · Tiramisu
- **What we tried:** an entity with attribute `minBatch` (camelCase), which the best-practices skill's grammar (`[A-Za-z0-9._-]`, start with a letter) allows.
- **What happened:** the SDK's own `isValidAttributeName("minBatch")` returns `true`, the SDK sends it, and the node reverts: `an attribute name holds "B" (0x42) at byte 3, which is outside the name charset ("A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_", with a letter first)`. The error message lists "A"-"Z" as allowed while rejecting "B". `Kind` is rejected at byte 0 the same way. `minbatch` is accepted.
- **What we expected:** either uppercase works, or the SDK validator, the docs and the error text all say lowercase only.
- **Why it matters:** the failure costs a transaction round trip, and in an `executeBatch` one bad name reverts every other operation in the batch. For a relayer batching many users' records, one user's camelCase attribute failed everyone.
- **Reproduce:** `npx tsx spike/06-attribute-case.ts`.
- **Workaround in Arkognito:** client and relayer both enforce `^[a-z][a-z0-9._-]*$` before a record can join a batch, and a failed batch is split in halves and retried so one bad record cannot sink the others.

## `WalletArkivClient` type hides viem's signing actions that exist at runtime — 9 Oct 2026

- **SDK / network:** 0.8.1
- **What we tried:** pass the client from the SDK's `createWalletClient` to code that calls `signTypedData` / `signMessage`.
- **What happened:** TypeScript error `Property 'signTypedData' is missing in type ...`. At runtime the method is there: `createWalletClient` does `.extend(publicActions).extend(walletActions).extend(walletArkivActions)`, but the declared `WalletArkivClient` type only carries part of `walletActions`.
- **What we expected:** the type to match what the client actually has, so a builder can sign an EIP-712 message with the same client that writes entities.
- **Reproduce:** `const w = createWalletClient({ chain: tiramisu, transport: custom(window.ethereum), account }); w.signTypedData({...})` → type error.
- **Workaround in Arkognito:** accept any object with an `account`, check for the signing methods at runtime, and give a clear error if they are missing.

## The SDK's own page iterator breaks when a block lands mid page-through — 10 Oct 2026

- **SDK / network:** 0.8.1 · Tiramisu
- **What we tried:** `for await (const e of client.select({...}).where(eq("project", p)).limit(200))` over ~200 records while other transactions were landing.
- **What happened:** `QueryError: Query rejected (cursor, -32005): Request exceeds defined limit.` with data `cursor belongs to a different query, block or select — start a new page-through`. The iterator reads page 1 at the head, then asks for page 2 at the new head with page 1's cursor.
- **What we expected:** the built-in iterator to finish a page-through, since it is the documented way to page.
- **Reproduce:** page through more than 200 entities while writing to the chain from another process; it fails intermittently (it passed in one run of our phase 2 test and failed in the next).
- **Suggestion:** pin the iterator to the first page's `blockNumber` automatically, and make the error message say "the head moved, pin with atBlock".
- **Workaround in Arkognito:** every page-through calls `.atBlock(await client.getBlockNumber())` first.

## The SDK refuses `$createdAt` filters that the node supports — 10 Oct 2026

- **SDK / network:** 0.8.1 · Tiramisu
- **What we tried:** `eq("$createdAt", u64(n))`, which the JSON-RPC reference lists as queryable ("must use u64 tag").
- **What happened:** the SDK throws before sending: `"$createdAt" is returned in query results but carries no index, so it cannot be filtered on`. The same filter sent as a raw query (`client.query("… AND $createdAt = u64(352358)")`, or `arkiv_query` over curl) works and returns the right entities.
- **Why it matters:** filtering by creation block is how a privacy-conscious client fetches "the whole batch my record is in" without naming the record.
- **Reproduce:** `npx tsx --conditions=development spike/07-createdat-query.ts`, then the curl in the same file's comment.
- **Workaround in Arkognito:** batch fetches use the raw `query()` method.

## Docs: explorer URL and npm tag are out of date in places — 9 Oct 2026

- The best-practices skill says npm `latest` is 0.7.0 and to install `@dev`; `npm install @arkiv-network/sdk@0.8.1` works today.
- Some of our earlier notes used `tiramisu.explorer.arkiv.network`; the explorer is `https://indexer.tiramisu.db-chain.testnet.arkiv.network`.

## Anonymous historical-query budget exhausted during proof-on-read tests — 17 Oct 2026

- **SDK / network:** `@arkiv-network/sdk` **0.8.1**, `viem` **2.57.4**, Node **22.23.3**; Tiramisu chain **7738577**, `https://rpc.tiramisu.db-chain.testnet.arkiv.network`.
- **What we expected:** the bounded follow-up would complete repeated historical group/member reads for a small proof-gated endpoint, or surface an actionable provider-budget error. No exact anonymous quota was assumed.
- **What happened:** after the 205-member pagination and repeated proof/read fixtures, `arkiv_query` for the three-member follow-up group returned **HTTP 429**, details **`"ANON_COST_LIMITED"`**. Error stem: `HTTP request failed. Status: 429 ... Details: "ANON_COST_LIMITED" Version: viem@2.57.4`. The first restart/race tests never reached their post writer callbacks. This was a provider budget response, not proof failure or an empty group. The experiment HTTP wrapper incorrectly returned 400 for the underlying read failure; that classification is an application defect.
- **Reproduce:** on the anonymous endpoint, perform repeated `.select(...).where(project/type/trusted creator).atBlock(rootBlock).limit(200)` page walks while validating posts. `spikes/risk-state/race-rate-limited-attempt.json` retains the exact sanitized queries and response. Exhaustion depends on the provider's current quota/window; no deterministic threshold is established by this run. Do not deliberately flood the RPC to reproduce it.
- **Workaround observed:** server-side `X-API-KEY` using the already configured access key allowed `spikes/risk-state/resume.mjs` to complete against the existing confirmed group. No key was put in a URL or browser and no confirmed create/funding was repeated. A verified immutable root cache, bounded work, backoff and returning 503 for unavailable dependencies would reduce query pressure.
- **What would improve it:** document anonymous query-cost/window limits and recovery guidance for `ANON_COST_LIMITED`, and expose actionable retry/quota metadata where available. The SDK correctly preserved the HTTP status in this case; this is an operational integration rough edge, not evidence that historical reads are unsupported.
