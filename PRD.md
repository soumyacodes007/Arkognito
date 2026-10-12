# Arkognito: unlinkable ownership for Arkiv

PRD v1.1 · 9 October 2026 · One-day build: 9 October 2026, 1:00 pm IST to 1:00 am IST

Focus: **privacy** first, **open source** second. First real user: Kendra Watch, which uses Arkognito as a disclosed dependency.

---

## 1. Problem

On Arkiv, every entity records two addresses: its `$owner` and its `$creator`. Both are indexed, so anyone can run one query like `eq("$owner", addr(wallet))` and get every record a wallet has ever written, across every Arkiv app.

We confirmed this in the official SDK (`@arkiv-network/sdk` 0.8.1): the queryable system attributes are exactly `$key`, `$owner`, `$creator` and `$expiresAt`.

What that means for a real person:

- A patient who reports medicine stock on Kendra Watch, asks for help on a mentorship app and keeps notes on a wiki app is one owner query away from a full activity profile.
- On Kendra Watch, the list of medicines one wallet keeps reporting can hint at a health condition.
- The link is permanent. A user cannot take it back after the fact, because `$creator` never changes even if ownership is transferred.

Who is harmed:

- **End users** of any Arkiv app, whose separate small actions add up to a profile they never agreed to.
- **Builders**, who today must choose between "users sign with their main wallet" (linkable) and "we write everything from our server wallet" (users lose ownership, and the server becomes a single point of control).

On other chains this is solved for payments with stealth addresses. Fluidkey gives each payment a fresh address and reported close to $500K a month in volume ([QuickNode](https://www.quicknode.com/ko/blog/feature-fridays-fluidkey)). Nobody has done it for **data**, and nobody has done it on Arkiv.

## 2. Solution

Arkognito is an SDK plus an open relayer that lets an Arkiv app write records owned by fresh, unlinkable addresses, while the user can still find and prove their own records later.

In one line: **records stay owned by the user, but nobody can tell which records belong to the same user.**

How it works, in short:

1. The user's wallet signs one message once. From that signature the SDK derives a private root key, locally, in the browser.
2. Each record gets its own child address `S`, derived from the root. Only the user can recompute these addresses.
3. A shared relayer creates the record and transfers ownership to `S` in the same transaction. So `$creator` is the relayer (shared by everyone) and `$owner` is `S` (used once).
4. The relayer never learns the user's main wallet. Rate limits use blind tokens, so the relayer can enforce "5 records per person per day" without knowing who sent which record.
5. The relayer collects requests, shuffles them and writes them together in one `executeBatch` transaction, so timing does not reveal who wrote what.

### Who uses it

| User | What they do | What they get |
| --- | --- | --- |
| Arkiv app builder | Swaps `createEntity` for `ark.createEntity`, same parameters | Private-by-default writes without running crypto or a server |
| End user of that app | Signs one message in their wallet | Their records cannot be joined into a profile |
| Anyone | Runs a relayer from the Docker image | No single company controls the privacy layer |

### v1 scope

| In | Out (future work) |
| --- | --- |
| Signature-based key derivation, per app, per record | Zero-knowledge proofs of any kind |
| Relayer that creates and transfers in one batch | Full Oblivious HTTP deployment (we show the design and a Tor demo) |
| Batching with shuffle, minimum batch size, max wait | Decoy records |
| Blind token rate limits (RFC 9474) with daily keys published on Arkiv | Smart contract wallets (Safe, passkey wallets) |
| `myEntities()`, `proveOwnership()`, signed record envelope | Paying relayers, staking, mainnet |
| Fingerprint guard: expiry buckets, payload padding, attribute check | Patch and delete from `S` (stretch goal: gas drip) |
| Two live relayers, npm package, spec, demo app | |

## 3. Product surfaces and hosting

| Surface | What it is | Where |
| --- | --- | --- |
| `arkognito` SDK | TypeScript package, browser and Node | npm, MIT, GitHub |
| Relayer + token issuer | Node service: issues blind tokens, batches writes, transfers ownership | Railway, 2 instances (`relay-1`, `relay-2`), Docker image for anyone |
| Demo app | Arkiv's own MetaMask Sketch App tutorial, made private, plus a before/after "what can an observer see" page | Vercel |
| Kendra Watch | First production user | Vercel (its own project) |

Railway Hobby is $5 a month with $5 of usage included ([Railway pricing](https://docs.railway.com/pricing/plans)). Two small Node services should fit.

### Environment and secrets

Nothing secret ever goes on Arkiv. Rules disqualify secrets or personal data on Arkiv, even hashed.

| Variable | Where | Note |
| --- | --- | --- |
| `ARKIV_RPC_URL`, `ARKIV_WS_URL` | Railway, Vercel | Tiramisu, chain ID `7738577` |
| `ARKIV_ACCESS_KEY` | Railway | Higher rate limits from the Arkiv Hub |
| `RELAYER_PRIVATE_KEY` | Railway, one per relayer | Funded testnet wallet, the shared `$creator` |
| `ISSUER_RSA_KEY` | Railway, issuer only | Daily blind signing key, rotated; public half goes on Arkiv |
| `ISSUER_WALLET_KEY` | Railway, issuer only | Signs the daily public key entity |

## 4. API

```ts
import { createPrivateClient } from "arkognito"

const ark = await createPrivateClient({
  wallet,                         // viem wallet client, used once to sign the derivation message
  app: "kendra-watch",            // addresses are separate per app
  relayers: ["https://relay-1.example", "https://relay-2.example"],
})

// Same parameters as @arkiv-network/sdk createEntity
const { entityKey, owner } = await ark.createEntity({ payload, contentType, attributes, expires })

// Continuity when you want it: records in one scope share one address
await ark.createEntity({ payload, contentType, attributes, expires, scope: "my-public-profile" })

// Find all of your own records again (downloads the app set, filters locally)
const mine = await ark.myEntities()

// Reveal that one record is yours, to one verifier, for one challenge
const proof = await ark.proveOwnership(entityKey, { challenge })

// Warns before writing anything too identifying
ark.check({ attributes, expires, payload })
```

## 5. Architecture

### Components

```
 Browser (SDK)                       Relayer / Issuer (Railway)            Arkiv (Tiramisu)
 ─────────────                       ──────────────────────────            ────────────────
 1. sign derivation msg (once)
 2. fetch issuer key  ───────────────────────────────────────────────────▶ arkognito.issuerKey (daily)
 3. get blind tokens  ─────────────▶ check wallet quota, blind-sign
    (random time, in advance)        (never sees the token itself)
 4. derive S, sign envelope
 5. send record + token ───────────▶ verify token, check spent list ─────▶ arkognito.spent
    (random delay 0 to 20 s)         queue, wait for k records
                                     shuffle, predict keys
                                     executeBatch: creates + transfers ─▶ records ($creator = relayer,
                                                                                    $owner = S)
 6. verify owner == S, sig valid ◀────────────────────────────────────── query by key
```

### Key derivation

1. The wallet signs an EIP-712 message: `{ purpose: "arkognito key v1", app, chainId: 7738577 }`. The domain and purpose stop a phishing site from getting the same signature for a different app or chain.
2. `root = HKDF-SHA256(signature, info = "arkognito/root/v1/" + app)`.
3. Record key `i`: `k_i = HKDF(root, info = "record/" + i)`, reduced to a valid secp256k1 key. `S_i` is its address.
4. Scoped key: `k_scope = HKDF(root, info = "scope/" + scopeName)`.

Umbra uses the same idea of hashing a wallet signature into keys, and warns it only works with wallets that produce deterministic ECDSA signatures (RFC 6979) ([umbra-js](https://npmjs.com/package/@umbracash/umbra-js)). The SDK checks this (see edge cases).

### Record envelope

Every Arkognito record's payload is a small JSON envelope:

```json
{ "v": 1, "data": "<app payload, base64>", "sig": "<signature by S over keccak(data, attributes, expiresBucket, app)>" }
```

The signature proves the content came from the owner `S`, not from the relayer. Readers verify that `recover(sig) == $owner`. A relayer that edits content gets caught.

### Blind tokens

- Scheme: RSA blind signatures, variant `RSABSSA-SHA384-PSS-Randomized`, the variant RFC 9474 recommends ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html)). Library: `@cloudflare/blindrsa-ts` (0.4.6 on npm).
- One issuer key per app per day. The public half is published on Arkiv as `arkognito.issuerKey`, written by the issuer's known wallet. Clients only accept keys found there.
- Each token is a random 32 byte nonce. On redemption the relayer checks the signature, then records `sha256(nonce)` as a `arkognito.spent` entity so no token works twice.
- Quota: N tokens per wallet per day (default 5). The issuer sees the wallet and the count, never the token.

### Batching

- Flush when at least `k = 5` requests are waiting **or** 60 seconds pass, but never more often than every 5 blocks (about 10 seconds).
- Shuffle the order before writing.
- One writer queue per relayer wallet (see edge cases on key prediction).
- Each batch writes creates first, then ownership transfers. We confirmed in the SDK source that `executeBatch` encodes operations in this order: creates, patches, deletes, extensions, ownership changes.

### Entity types

| Type | Owner | Attributes | Payload | Expiry |
| --- | --- | --- | --- | --- |
| App record (any schema) | `S` (creator: relayer) | The app's own, after the fingerprint check | Arkognito envelope | App picks, rounded to a bucket |
| `arkognito.issuerKey` | Issuer wallet | `type`, `app`, `epoch` (day number) | RSA public key (SPKI) | End of epoch + 2 days |
| `arkognito.spent` | Relayer | `type`, `app`, `epoch`, `tokenId` (sha256 of nonce) | None | End of epoch + 1 day |
| `arkognito.relayer` | Relayer | `type`, `version`, `url`, `minBatch` | None | 150 blocks (about 5 minutes), renewed |

`arkognito.relayer` doubles as a heartbeat: a relayer that dies drops out of discovery on its own when the entity expires.

### Repo layout

```
arkognito/
  packages/sdk        derivation, envelope, client, check(), myEntities(), proveOwnership()
  packages/relayer    issuer, token verify, spent list, batcher, writer queue, heartbeat
  apps/demo           private Sketch App + "observer view" before/after page
  spec/SPEC.md        token format, envelope, derivation, relayer API (so others can reimplement)
  arkiv/schema.md
  arkiv/friction.md
```

## 6. Threat model

| Adversary | Sees | Must not learn |
| --- | --- | --- |
| Outside observer (anyone reading Arkiv) | All records, owners, creators, blocks, batches | Which records belong to the same person |
| Relayer | Tokens, records, `S` addresses, request times, IPs | Which main wallet sent which record |
| Issuer | Main wallet, how many tokens it took, when | Which records those tokens paid for |
| App frontend host | Main wallet and derived keys in the user's browser | (We cannot hide this; we minimise it, see 7.6) |
| RPC provider | Queries and IPs | The set of addresses belonging to one user |

We assume the relayer and the issuer may be run by the same team (us). Section 7 covers what that changes.

## 7. Edge cases

Each edge case has a decision. "v1" means we build it now; "limit" means we document it honestly.

### 7.1 Keys and wallets

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| K1 | Wallet signs non-deterministically (some MPC, passkey or hardware setups) | Next login derives different keys; user loses all their records | v1: sign twice at setup and compare. If different, refuse signature mode and offer a random root key with a downloadable recovery code |
| K2 | Smart contract wallets (Safe, ERC-1271) | Signature is a contract check, not a stable ECDSA value | Limit: not supported in v1; SDK detects and explains |
| K3 | Phishing site asks for the same signature | Attacker derives every address and links everything | v1: EIP-712 with fixed purpose, app and chain ID in the domain. Wallet shows "arkognito key v1" so users can spot misuse |
| K4 | Main wallet signature leaks anyway | All past records become linkable, forever | Limit: rotate with a new `v2` purpose for future records; past records stay exposed. Say so in the docs |
| K5 | User loses their wallet | Records still exist but the user cannot find or prove them | Limit: same as losing the wallet itself. Random-root mode has a recovery code |
| K6 | Same keys reused on another network later | Tiramisu records linkable to mainnet records | v1: chain ID inside the derivation message |
| K7 | Two devices create record `i` at the same time | Same `S` used twice; those two records are linkable to each other (not to the user) | v1: before using `S_i`, query whether it already owns anything; skip if so. Scopes avoid counters entirely |
| K8 | User has many records; finding them needs a scan | Counters may have gaps after failed writes | v1: scan with a gap limit of 20, like BIP44 wallets |

### 7.2 Relayer behaviour

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| R1 | Relayer edits payload or attributes | It writes the transaction, so it could | v1: signed envelope; SDK verifies after inclusion; apps reject records whose signature does not match `$owner` |
| R2 | Relayer transfers to its own address, or never transfers | User loses ownership | v1: SDK checks `$owner == S` after inclusion; on mismatch, marks the relayer bad and retries with another |
| R3 | Relayer drops or delays requests (censorship) | User's record never appears | v1: timeout of 3 batch windows, then retry through the second relayer with the same `S` and a new token |
| R4 | Late delivery plus retry both land | Duplicate records with the same `S` | v1: apps dedupe by `(S, content hash)`; acceptable, it reveals nothing new |
| R5 | Predicted keys go wrong because two batches from one wallet are in flight | `predictEntityKeys` is only valid while nothing else from that owner is in flight; a transfer to a wrong key fails the batch | v1: one writer queue per relayer wallet; on revert, re-predict and resend |
| R6 | Relayer runs out of testnet gas | All writes stop | v1: balance check every minute, alert below a threshold; fund early from the faucet |
| R7 | Relayer logs IP plus request | Links the network identity to `S` | Limit in v1 (open code, no logging policy, run your own relayer, Tor demo). Oblivious HTTP is the real fix ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458)); `ohttp-js` exists for a later version |
| R8 | Only one relayer is alive | Single point of failure and of observation | v1: two relayers; discovery through `arkognito.relayer` heartbeats |

### 7.3 Tokens

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| T1 | Issuer gives one user a unique key ("key consistency" attack) | The token then identifies that user | v1: keys only valid if published on Arkiv by the issuer wallet; exactly one key per app per day; two entities for the same day = the client refuses and reports equivocation. Matches the Privacy Pass guidance on consistency ([RFC 9576](https://datatracker.ietf.org/doc/rfc9576/)) |
| T2 | Token fetched right before use | Issuer and relayer (same team) can match timestamps | v1: SDK fetches the day's tokens in advance, at a random time, never on demand. RFC 9576 recommends separating issuance and redemption in time |
| T3 | Same IP at issuer and relayer | Links issuance and redemption | Limit: same as R7 |
| T4 | Token spent twice, at two relayers at once | Quota bypass | v1: shared `arkognito.spent` list on Arkiv; relayer checks right before writing and includes the spent marker in the same batch; cross-relayer race of about one block is detected after the fact and logged |
| T5 | Sybil: one person, many wallets | Quota is per wallet, and wallets are free | Limit for v1, stated plainly. Real fix is a stronger attester at issuance: for Kendra Watch, a one-time code handed out at the Kendra counter, so tokens need a real visit |
| T6 | Users share or sell tokens | Bypasses per-person limits | Limit: RFC 9576 calls this hoarding; short daily expiry keeps the damage small |
| T7 | Per-Kendra limits ("1 report per Kendra per day") | Binding a token to a Kendra tells the issuer where you went | Decision: daily total quota only. App logic must not trust "3 reports" as "3 people"; Kendra Watch weighs owner confirmations more |
| T8 | Using the signing key for anything else | RFC 9474 forbids key reuse across protocols | v1: dedicated RSA key per app per day, used for nothing else |
| T9 | Day boundary | Tokens from yesterday | v1: accept tokens of the current and previous epoch for 1 hour after midnight UTC |

### 7.4 Timing and batching

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| B1 | "Request arrives, 120 ms later the entity appears" | Direct timing link | v1: batching every 5+ blocks with shuffle, plus 0 to 20 s random client delay |
| B2 | Quiet hours: fewer than `k` users | Anonymity set of 1 or 2 | v1: wait for `k = 5` up to 60 s, then write anyway and show the real batch size to the user ("you were 1 of 2") |
| B3 | Decoys to fill small batches | Decoy records would pollute public app data (for example fake stock reports) | Out of scope for v1 |
| B4 | One user sends several records in a burst | They land in the same batch, which hints they are related | v1: the client spreads its own records across batches (at most one per batch per user) |
| B5 | Relayer flush times are predictable | Fine; they are the same for everyone | No change |

### 7.5 Fingerprinting by content

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| F1 | Unusual expiry (for example 37 days) | Unique expiry links records | v1: SDK rounds expiry to buckets: 1 hour, 1 day, 7 days, 30 days, 90 days |
| F2 | Payload size | An encrypted payload's length still leaks | v1: pad to 256 B, 1 KB, 4 KB, 16 KB, 64 KB buckets |
| F3 | Exact timestamps or high-detail attributes (tiny pincode, full GPS) | Identifies a person without any address | v1: `ark.check()` warns on timestamps, more than 4 decimals of location, free-text attributes; docs suggest coarse values |
| F4 | App-specific rare attribute names | Reveal the app, not the person | Accepted; the app is public anyway |
| F5 | Content itself identifies (only one person visits that small-town Kendra) | No cryptography fixes this | Limit, stated in docs and pitch |

### 7.6 Reading your own data

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| D1 | `myEntities()` asks the RPC for "owner in [S1, S2, ...]" | The RPC provider learns your full address set, undoing the whole thing | v1: download every record for the app (`$creator` = known relayers, by page of 200, keys and owners only) and filter locally against derived addresses |
| D2 | Large apps make D1 slow | Many pages | v1: cache by block; limit: fine at hackathon scale, needs an index later |
| D3 | The app's frontend sees the main wallet and the derived keys | A malicious or tracking frontend can link everything. A study found about 35% of connected dapps leaked wallet addresses to third parties such as Google Analytics, Mixpanel and Sentry ([arXiv](https://arxiv.org/html/2306.08170v1)) | v1: derivation runs in a Web Worker and never exposes the root key; docs require no third-party analytics on Arkognito pages; demo frontend is open and static. Limit: a hostile frontend can still cheat |
| D4 | `proveOwnership` proof gets replayed | Someone reuses your proof | v1: the proof signs `{ entityKey, challenge, verifier, expiresAt }` |
| D5 | User wants to prove "I own 3 records" without saying which | Needs zero-knowledge proofs | Out of scope |

### 7.7 Arkiv-specific

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| A1 | `$creator` is permanent and indexed | Transferring ownership later does not hide the original writer | v1: the relayer creates every record, so `$creator` is shared by all users |
| A2 | `OwnershipTransferred` event shows relayer to `S` | Reveals that `S` is a Arkognito user | Accepted; that is the anonymity set |
| A3 | `S` has no gas | `S` cannot patch, extend or delete its own record | v1: records are create-only; updates are new records, and old ones expire. Stretch: a "gas drip" paid with a token |
| A4 | `permissionlessExtension` lets anyone extend | Gasless renewals, but a stranger can keep your record alive forever, so you lose the ability to be forgotten by expiry | v1: off by default; opt in per record only for data that should live long |
| A5 | `extendEntity` sets a new expiry from now, and rejects one that is not later | Renewals behave unexpectedly | Same handling as the Triggers PRD: compute the target, treat "not later" as a no-op |
| A6 | Expired records may still be visible in old transactions on the block explorer | Expiry may not equal erasure | Day-one test. If true, docs say expiry limits queries, not history, and anything sensitive must be encrypted |
| A7 | Query pages max at 200; `orderBy` has no effect; no count | Affects D1 and the demo | Page by cursor, sort in JS |
| A8 | Limits: 32 attributes, 32 byte names, 128 byte strings, 128 KB payload | Signature does not fit in a string attribute | Signature lives in the payload envelope |
| A9 | SDK 0.8.x required; `viem` is a peer dependency | Build breaks | Pin `@arkiv-network/sdk@0.8.1` and `viem` |
| A10 | Rules ban personal data, even hashed | Disqualification | Only derived addresses, random token hashes and app data go on Arkiv; all demo data is synthetic |

### 7.8 Abuse

| # | Edge case | Why it matters | Decision |
| --- | --- | --- | --- |
| X1 | Unlinkable spam or false reports | Privacy helps bad actors too | v1: token quotas; apps moderate by content; Kendra Watch's challenge window and owner confirmations |
| X2 | Banning a bad actor | We cannot ban a person we cannot see | v1: ban at issuance (the wallet or attester code), never at the record level |
| X3 | Relayer used to dump large junk payloads | Costs relayer gas | v1: max payload 16 KB per token; larger needs more tokens |

## 8. Build plan

The whole product is built in one day, 9 October 2026. Work starts at 1:00 pm IST; target finish is 1:00 am IST on 10 October. Each phase ends with a test that must pass before the next starts. If a phase runs over by more than 30 minutes, cut scope from that phase (see §13) rather than pushing the later phases back.

| Phase | Time (IST, 9 Oct) | Focus |
| --- | --- | --- |
| 1 | 1:00 pm to 2:00 pm | Spike on Tiramisu |
| 2 | 2:00 pm to 4:30 pm | SDK core |
| 3 | 4:30 pm to 7:00 pm | Relayer network |
| 4 | 7:00 pm to 9:30 pm | Blind tokens |
| 5 | 9:30 pm to 11:30 pm | Fingerprint guard and demo |
| 6 | 11:30 pm to 12:30 am | Docs, measurements, deploy, publish |
| 7 | 12:30 am to 1:00 am | Final check |

### Phase 1 · 1:00 pm to 2:00 pm · Spike on Tiramisu

Build: scripts that test the assumptions this design rests on.

Test (all must pass, or we change the design):

1. One `executeBatch` with 5 creates and 5 ownership transfers to predicted keys succeeds. `$creator` = relayer, `$owner` = `S`.
2. Two overlapping batches from one wallet: confirm that the second one fails or mispredicts (proves R5 matters).
3. `eq("$owner", S)` and `eq("$creator", relayer)` queries work.
4. MetaMask signs the EIP-712 derivation message twice with identical results.
5. After a record expires, check whether its payload is still visible in the transaction on the block explorer (A6). Write the result in `friction.md`.

### Phase 2 · 2:00 pm to 4:30 pm · SDK core, no tokens yet

Build: derivation, envelope, `createEntity` through a simple relayer, owner and signature verification, `myEntities()` with download-and-filter, `proveOwnership()`.

Test:

- A user creates 10 records; `myEntities()` returns exactly those 10 from a set of 200 records by 5 users.
- A tampered payload is rejected by the reader.
- A relayer that transfers to the wrong owner is detected.

### Phase 3 · 4:30 pm to 7:00 pm · Relayer network

Build: batcher with shuffle, `k` and max-wait rules, single writer queue, heartbeat entities, two relayers (run locally first, Railway in Phase 6), failover in the SDK.

Test:

- 5 synthetic users send 50 records over 10 minutes. An outside observer script, given only chain data, tries to group records by person. Target: no better than random guessing within each batch.
- Kill `relay-1` mid-batch. Every record still lands through `relay-2`, none twice per `S` without dedupe.

### Phase 4 · 7:00 pm to 9:30 pm · Blind tokens

Build: issuer, daily keys on Arkiv, blind issuance with `@cloudflare/blindrsa-ts`, redemption, `arkognito.spent` list, quotas, advance fetching at random times.

Test:

- Issuer and relayer logs together cannot match any issued token to a redeemed one (check by trying, with both logs).
- The same token spent twice is rejected.
- Publishing a second key for the same day makes every client refuse that issuer.
- A wallet over its daily quota is refused tokens.

### Phase 5 · 9:30 pm to 11:30 pm · Fingerprint guard and demo

Build: expiry buckets, padding, `ark.check()`, private Sketch App port, "observer view" demo page. Kendra Watch integration (patient reports through Arkognito, Kendra owners stay public on purpose) is handed to the Kendra Watch team with the published SDK; it is not on today's critical path.

Test:

- The Sketch App becomes private by changing 3 lines or fewer.
- `ark.check()` flags a timestamp attribute and a 6-decimal coordinate.

### Phase 6 · 11:30 pm to 12:30 am · Docs, measurements, deploy, publish

Build: README, `spec/SPEC.md`, `arkiv/schema.md`, `arkiv/friction.md`, the linkage experiment write-up with the exact queries. Deploy two relayers to Railway and the demo to Vercel. Publish `arkognito@0.1.0` on npm.

Test: a teammate who did not build Arkognito makes a new app private in under 15 minutes using only the README.

### Phase 7 · 12:30 am to 1:00 am · Final check

Open every live link in a private window with no wallet installed. Record the 3-minute demo if time allows.

## 9. Demo (3 minutes)

1. **The leak (40 s).** Run one owner query on a normal Arkiv wallet. Its whole history appears: medicine reports, notes, sketches.
2. **The fix (60 s).** Same actions through Arkognito. The same query now shows nothing useful. The observer view shows records scattered across one-time owners, written in shuffled batches.
3. **Still yours (40 s).** `myEntities()` finds every record; `proveOwnership()` proves one of them to a verifier.
4. **Builders (40 s).** The Sketch App made private in 3 lines, then the real numbers from the linkage experiment and the honest limits.

## 10. Positioning (draft)

**Privacy: who is harmed if this data leaks?** Any Arkiv user whose separate actions can be joined into one profile by a single owner query. On Kendra Watch, that profile can reveal which medicines someone keeps looking for. Arkognito keeps each record owned by the user but unlinkable to their other records.

**Open Source: who is harmed if this were closed or shut down?** Every Arkiv app that would otherwise have to trust one company's private relayer, which could start logging or switch off. Arkognito is MIT licensed, has a written spec, and anyone can run a relayer from the Docker image.

**Why Arkiv:** the problem exists because Arkiv indexes `$owner` and `$creator`. The fix uses Arkiv features directly: batch create-and-transfer, expiring heartbeats and spent lists, and daily issuer keys published on Arkiv so clients can check that everyone gets the same key.

**Kept off Arkiv on purpose:** the root key, the wallet signature, the mapping between main wallet and addresses, relayer logs, issuer private keys, any attester data.

## 11. Known limits (say them before the judges do)

- The relayer sees IP addresses (R7, T3). Fix: Oblivious HTTP or Tor.
- Anonymity is only as large as each batch (B2).
- Quotas are per wallet, not per person, without a strong attester (T5).
- The app frontend can see everything in the browser (D3).
- Content can identify people regardless of addresses (F5).
- Expiry may not erase old transaction data (A6, pending test).

## 12. Success targets by end of build day

- Linkage experiment: an outside observer does no better than random guessing inside each batch.
- 0 tokens accepted twice; 0 records with a wrong owner left undetected.
- Average batch size at least 5 during the demo period.
- 2 real users of the SDK: Kendra Watch and the private Sketch App. Stretch: 1 outside team.
- A new builder goes private in under 15 minutes from the README.

## 13. Risks

| Risk | Fallback |
| --- | --- |
| Batch create-and-transfer fails on Tiramisu | Two transactions per batch (creates, then transfers), accept the short window where the relayer owns the record |
| Blind tokens take longer than planned | Ship batching and derivation first (phases 2 and 3 are already a strong demo); tokens become "phase 2 of the project" in the pitch |
| One day is not enough for everything | Cut order, last first: Railway deploy (run locally), npm publish (install from GitHub), Sketch App port (observer view only), payload padding |
| Too few users for meaningful batches during judging | Run a public load script with synthetic users and show the measured numbers |
| Wallet signature non-determinism on judges' wallets | Random-root mode with recovery code, tested on MetaMask and Rabby |

## Sources

- `@arkiv-network/sdk` 0.8.1 typings and source, read on 7 to 9 October 2026 (queryable system attributes, `executeBatch` order, `predictEntityKeys`, creation flags, limits)
- [RFC 9474: RSA Blind Signatures](https://www.rfc-editor.org/rfc/rfc9474.html)
- [RFC 9576: Privacy Pass Architecture](https://datatracker.ietf.org/doc/rfc9576/)
- [RFC 9458: Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458)
- [umbra-js on npm](https://npmjs.com/package/@umbracash/umbra-js)
- [QuickNode: Fluidkey](https://www.quicknode.com/ko/blog/feature-fridays-fluidkey)
- [Is Your Wallet Snitching On You? (arXiv)](https://arxiv.org/html/2306.08170v1)
- [Railway pricing](https://docs.railway.com/pricing/plans)
- npm: `@cloudflare/blindrsa-ts` 0.4.6, `@cloudflare/privacypass-ts` 0.9.0, `ohttp-js` 0.1.5
