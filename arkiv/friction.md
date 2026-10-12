# Arkiv friction log

Specific, reproducible feedback on Arkiv rough edges, logged the same day we hit them.

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
