# AGENTS.md — Arkognito

Guidance for anyone (human or coding agent) working in this repo. Read the **Rules** section before writing code. The full product spec is in [`PRD.md`](PRD.md).

## Rules (non-negotiable)

- **No secrets or real personal data on Arkiv, ever — not even hashed.** This disqualifies the submission. Only derived addresses, random token hashes and synthetic app data go on Arkiv.
- **Never put on Arkiv:** the root key, the wallet signature, the mapping between a main wallet and its derived addresses, relayer logs, issuer private keys, any attester data.
- **Demo data is synthetic.**
- **Pin `@arkiv-network/sdk@0.8.1`** and `viem` (peer dependency). Pass `select()` selections inline, or use `as const`, otherwise types are lost.
- **One wallet per relayer, one write queue per wallet.** `predictEntityKeys` is only valid while nothing else from that owner is in flight (edge case R5).
- **Log every Arkiv rough edge in `/arkiv/friction.md` the same day**, with steps to reproduce.
- **One-day build.** If a phase runs more than 30 minutes over, cut scope (PRD §13) instead of pushing later phases back.
- **Every phase ends with a test that must pass before the next starts** (see PRD §8).
- License is **MIT**.

## Arkiv best practices

From the official [Arkiv-Network/skills](https://github.com/Arkiv-Network/skills), copied into `.claude/skills/` (read `arkiv-best-practices/SKILL.md` before touching Arkiv code). How each one applies here:

| Practice | In Arkognito |
| --- | --- |
| Every entity carries a unique project attribute | Arkognito's own entities (`arkognito.issuerKey`, `arkognito.spent`, `arkognito.relayer`) carry `project: "arkognito-7f3k"`. App records carry the **app's** project attribute, never a Arkognito marker: an extra attribute only shrinks the anonymity set, and D1 already finds Arkognito records by `$creator` |
| Filter trusted data with `.createdBy()` | `myEntities()` and every relayer/issuer read filter by the known relayer and issuer wallets, so anyone can write a fake `arkognito.issuerKey` but clients never trust it |
| Never parallelize writes from one wallet | One process, one writer queue per relayer wallet. Each batch is one `executeBatch` = one nonce. No `Promise.all` over writes |
| Use an RPC access key | Send `ARKIV_ACCESS_KEY` as the `X-API-KEY` header via viem `http(url, { fetchOptions })`. Server side only; never ship it to the browser |
| Separate read and write clients | `createPublicClient` everywhere except the relayer writer and issuer publisher |
| Pass `select()` inline or `as const` | Same rule as above |
| `ne()`, `exists()`, `hasType()` are not implemented on the node | Use `not(eq(...))`; never `ne` |
| No server ordering, 200 per page, `.limit()` applies before your sort | Page with the async iterator, sort in JS |
| Typed attributes: bare number is `i32`, bare float throws, `$expiresAt`/`$createdAt` need `u64` | `epoch` is `i32`; block numbers are `u64` |
| Expiry fires no event; `getEntity` throws `NoEntityFoundError` when expired | Heartbeat and spent-list logic poll, they do not wait for events |
| SDK does not retry | Relayer wraps every RPC call with its own retry and backoff |
| Faucet gives 0.1 GLM per 24 h | Testnet gas is scarce: batch everything, right-size expiry, watch relayer balances (R6) |
| Report Arkiv bugs with `arkiv-feedback` | Log in `arkiv/friction.md` first; file upstream only after the user confirms |

Explorer: `https://indexer.tiramisu.db-chain.testnet.arkiv.network`

## One line

Records stay owned by the user, but nobody can tell which records belong to the same user.

## Repo layout

One TypeScript monorepo on Node 22 with `@arkiv-network/sdk` 0.8.1 and `viem`:

```
packages/sdk        derivation, envelope, client, check(), myEntities(), proveOwnership()
packages/relayer    issuer, token verify, spent list, batcher, writer queue, heartbeat
apps/demo           private Sketch App + "observer view" before/after page
spec/SPEC.md        token format, envelope, derivation, relayer API (so others can reimplement)
arkiv/schema.md     entity types, attributes, expiry per type, queries
arkiv/friction.md   reproducible feedback on Arkiv rough edges
docs/               linkage experiment write-up
examples/           quickstart.mjs (plain Node against the built package)
spike/, tests/      Phase 1 spike scripts; phase tests (on-chain) and unit tests
```

### Working in the repo

- Inside the repo, `arkognito` resolves to its TypeScript source through the private `arkognito-source` export
  condition (not `development`, which consumers' bundlers set). Run scripts with
  `tsx --conditions=arkognito-source` (the npm scripts already do). Without
  the flag you get `packages/sdk/dist`, so run `npm run build` first.
- SDK source imports use explicit `.ts` extensions; the build rewrites them to `.js` so the published
  package runs in plain Node.
- On-chain tests share the relayer wallets: run them one at a time, and stop `dev:relayers` first.
- Attribute names must be lowercase: the node rejects uppercase (see `arkiv/friction.md`).

## Schedule (9 Oct 2026, IST)

| Time | Phase |
| --- | --- |
| 1:00 pm – 2:00 pm | 1 · Spike on Tiramisu |
| 2:00 pm – 4:30 pm | 2 · SDK core |
| 4:30 pm – 7:00 pm | 3 · Relayer network |
| 7:00 pm – 9:30 pm | 4 · Blind tokens |
| 9:30 pm – 11:30 pm | 5 · Fingerprint guard and demo |
| 11:30 pm – 12:30 am | 6 · Docs, measurements, deploy, publish |
| 12:30 am – 1:00 am | 7 · Final check |
