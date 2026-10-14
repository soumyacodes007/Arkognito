# Edge cases

Every edge case we know of: the ones in the PRD (§7) and the ones we found while building. Each has a
status and the test that shows it.

- **Solved**: the code handles it and a test proves it.
- **Reduced**: the code narrows it; something is left, and we say what.
- **Inherent**: no code fixes it; documented so builders and users can decide.

Tests: `unit` = `npm test`, `p2`–`p5` = `npm run test:phaseN`, `edge` = `npm run test:edge`,
`issuer` = `npm run test:issuer`, `browser` = `apps/demo/test-worker-vault.html`.

## Network: who sees your IP

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| R7 | Relayer logs IP + request, linking a network identity to `S` | **Solved** with OHTTP; **Reduced** without | `ohttpRelay` option: every relayer call is HPKE-encrypted to the relayer's gateway key and sent through an independent OHTTP relay. The relay sees the IP, not the request; the relayer sees the request, not the IP. Gateway keys come from heartbeat entities on Arkiv, so a relay cannot swap in its own. Without OHTTP: relayers keep no logs, but you have to trust that. | unit (round trip, relay sees only ciphertext, wrong key fails), edge (client never contacts relayer; relay refuses unknown targets) |
| T3 | Same IP at issuer and relayer links issuance to redemption | **Solved** with OHTTP | Redemption goes through the relay, so the relayer never sees the IP that the issuer saw. | edge |
| N1 | OHTTP relay used as an open proxy | **Solved** | The relay forwards only to relayers announced in live heartbeats (or an explicit allowlist). | edge |
| N24 | Heartbeat squatting: anyone can publish a heartbeat claiming a real relayer's URL with their own key, to block it or capture traffic | **Solved** | The client tries every key claimed for a URL; only the real gateway can decrypt, and its answer must name that heartbeat's creator. A squatter's key just fails. | edge (fake heartbeat with a random key: client still reaches the real relayer) |
| N25 | SSRF through the relay: a fake heartbeat naming an internal address (e.g. 169.254.169.254) | **Solved** | The relay forwards only to `https` targets on public hosts that answer `/v1/info` with the heartbeat creator's address and the same gateway key; no redirects. `OHTTP_ALLOW_LOCAL=on` is for local development only. | edge (internal target refused; loopback refused in production mode) |
| N2 | Relay and relayer run by the same party | **Inherent** | OHTTP only helps if they do not collude. Run the relay under a different operator. | — |
| N3 | The Arkiv RPC provider sees your IP and what you read | **Reduced** | See "Reads" below: no read names your records. Your IP still reaches the RPC; use a different RPC, a VPN or Tor (`fetch` option) to hide it. | edge |

## Reads: what the RPC provider learns

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| D1 | `myEntities()` asking for "owner in [S1, S2…]" reveals your address set | **Solved** | The client downloads the app's (key, owner, tag) list for everyone, opens its own tags locally, and fetches only whole batches, plus 2 random cover batches. | edge (a recording RPC proxy: no read names a key or owner of yours) |
| N4 | Reading your record back right after writing it (`getEntity(key)`) told the RPC which record is yours | **Solved** | The post-write check fetches the whole batch by block and creator, never one key. | edge |
| N5 | Paging breaks when a block lands mid page-through (cursor tied to its block) | **Solved** | Every page-through is pinned with `atBlock(head)`. | p2 (200+ records) |
| D2 | Large apps make the download slow | **Reduced** | The list carries no payloads; payloads come per batch. Still linear in the app's record count. | — |

## Keys and finding your records

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| N6 | After your early records expire, a counter restarts and reuses an old `S`, linking new and old records in history | **Solved** | No counters. Each record's key comes from a fresh random 15-byte id. The id travels in the record's `vtag` attribute, AES-GCM-encrypted under a key only your root can derive; you find your records by trial-decrypting tags. | unit (200 keys, all distinct) |
| K7 | Two devices pick the same record address | **Solved** | Same: random ids, no shared counter. | unit, edge (phone + laptop, 3 distinct owners) |
| K8 | Gaps in counters hide records beyond a gap limit | **Solved** | Same: there is no gap limit to fall off. | edge (second device finds everything) |
| N7 | Tags themselves as a fingerprint | **Solved** | Every tag is 44 bytes (59 chars) for records and scopes alike, with a fresh IV each time. | unit, edge |
| K1 | Wallet signs non-deterministically | **Solved** | Signs twice the first time a device sees the wallet for an app and stores a 16-byte fingerprint; later connects sign once and compare. Refuses on mismatch, offers random-root mode with a recovery code. | unit, browser |
| K2 | Smart-contract wallets | **Reduced** | Detected and refused with a clear error (account has code). Not supported in v1. | — |
| K3 | Phishing site asks for the same signature | **Reduced** | EIP-712 with a fixed purpose, app and chain id; the wallet shows the requesting site. A user who signs it anyway on a phishing site loses unlinkability for that app. | — |
| K4 | The derivation signature leaks | **Inherent** | Past records become linkable. Rotate to a new purpose for future records. | — |
| K5 | Lost wallet | **Inherent** | Records stay on Arkiv but cannot be found or proven. Random-root mode has a recovery code. | unit |
| K6 | Same keys on another network | **Solved** | Chain id is in the derivation message. | unit |

## Browser compromise

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| D3 | The page (or a script it loads) reads derived keys | **Solved** for reading; **Reduced** overall | Keys live in a Web Worker; the page gets addresses, tags, ciphertext and signatures only. | browser (page-side object holds nothing but `app`) |
| N8 | A compromised page makes a one-time key sign anything (e.g. a statement linking it to your wallet) | **Solved** | Signers expose only `signEnvelope(fields)` and `signProof(fields)`; the worker builds each digest itself. There is no "sign these bytes". | unit, browser |
| N9 | A compromised page asks for ownership proofs of every record | **Inherent** | A hostile frontend can still use the worker as designed. Only load Arkognito on pages you trust; no third-party scripts. | — |
| N10 | Tokens in localStorage read by another script on the origin | **Reduced** | Tokens are unlinkable to records, so a stolen token reveals nothing; it can be spent by the thief (one write). | — |
| N11 | Two tabs submit at once and land in the same batch (B4 across tabs) | **Solved** where Web Locks exist | Writes take a `navigator.locks` lock per user per app. | — (browser API) |
| N23 | A server writing for many users in one process gets all of them serialised behind one lock (and a record waiting for `minAnonymity` blocks everyone) | **Solved** | The lock is per user: its name derives from the user's own vault and never leaves the machine. Found because Node 24 implements Web Locks. | edge (3 users in one process land in one batch) |

## Timing

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| B1 | "Request arrives, 120 ms later the record appears" | **Solved** | Batching every ≥ 5 blocks with shuffle, plus a 0–20 s client delay. | p3 |
| T2 | Token fetched right before use links issuance and redemption in time | **Solved** | Tokens are fetched at session start, kept across sessions (`browserTokenStore`), spent oldest first, and never before they are 60 s old. | unit (oldest first, min age) |
| B5 | Predictable flush times | Accepted | Same for everyone. | — |
| N12 | Polling the relayer's status reveals interest | Accepted | The relayer already knows the request; through OHTTP it does not know who asks. | — |

## Batches and anonymity sets

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| B2 | Quiet hours: a batch of 1 or 2 | **Solved** when asked for | `minAnonymity: k`: the relayer holds the record until a batch of ≥ k forms, up to `maxHoldMs`, and fails it rather than write it in a smaller batch. Default 1 (write anyway, report the size). | edge (alone → refused; 3 together → batch of 3) |
| B4 | One user's records in the same batch | **Solved** | One write in flight per client and per app across tabs. | p3 |
| N13 | Spent-token markers ordered like the records they paid for | **Solved** | Markers are shuffled separately from records. | — (code) |
| N14 | One bad record reverts everyone's batch | **Solved** | Strict validation before queueing; a failed batch is split in halves and retried. | — (code; validation in edge) |
| B3 | Decoys to pad small batches | Out of scope | Decoys would pollute public app data. `minAnonymity` is the honest alternative. | — |

## Content fingerprinting

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| F1 | Unusual expiry | **Solved** | Rounded up to 1 h / 1 d / 7 d / 30 d / 90 d. | unit |
| F2 | Payload size | **Solved** | Padded to 512 B / 1 KB / 4 KB / 16 KB. | unit, p3 |
| N15 | Encrypted records larger than plain ones | **Solved** | Padding always reserves room for encryption, so both land in the same bucket. | unit |
| F3 | Timestamps, precise locations, postal codes, free text in attributes | **Reduced** | `check()` warns; `coarse.day/hour/geo/bucket` helpers; `strict: true` refuses. | unit |
| N16 | A rare combination of ordinary values identifies the writer | **Reduced** | Rarity check (k-anonymity): warns when fewer than k (default 3) existing records share the values. | unit, edge |
| A6 | Expiry hides records from queries but the payload stays in transaction history | **Solved** for private data | `encrypt: true`: AES-256-GCM under a per-record key only the owner derives. Public data stays public by design. | unit, edge, friction |
| F4 | App-specific attribute names reveal the app | Accepted | The app is public anyway. | — |
| F5 | Content identifies a person by itself | **Inherent** | No cryptography fixes this. Documented. | — |

## Relayer behaviour

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| R1 | Relayer edits payload, attributes or expiry | **Solved** | Signed envelope; reader checks signature against `$owner`. | p2 |
| R2 | Relayer transfers to the wrong owner | **Solved** | Client verifies the batch, marks the relayer bad, retries elsewhere. | p2 |
| R3 | Relayer drops or delays (censorship) | **Solved** | Timeout when the queue stops moving; failover. | p3 |
| R4 | Relayer writes, then fails to say so; the retry writes a duplicate | **Solved** | Before retrying elsewhere the client looks for its own tag in a fresh listing and recovers the record. | edge (ghost relayer: one record, `recovered: true`) |
| R5 | Stale key predictions | **Solved** | One writer per wallet; re-predict on failure. | p1 |
| R6 | Relayer out of gas | **Reduced** | Balance checked every minute, alert below a threshold. | — |
| R8 | One relayer alive | **Solved** | Two relayers, discovery via heartbeats; dead ones expire out. | p3 |
| N17 | Stale heartbeat settings after a restart (old gateway key) | **Solved** | On start the relayer patches its existing heartbeat with current settings. | — (code) |

## Tokens and abuse

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| T1 | Issuer gives one user a unique key | **Solved** | Keys only from Arkiv; two for one day = refused. | p4 |
| T4 | Same token at two relayers at once | **Solved** + monitored | Shared spent list, checked at redemption and right before writing; any id recorded twice is reported. | p4, issuer |
| T5 | One person, many wallets | **Solved** when the issuer requires it | Optional attestation codes (e.g. handed out in person): quota per code, one day per code. Without codes: per (wallet, app) identity, stated plainly. | edge |
| T6 | Tokens shared or sold | **Reduced** | Daily expiry keeps the damage small. | — |
| T7 | Per-place limits would reveal where you went | Decision | Daily totals only. | — |
| T8 | Key reuse across protocols | **Solved** | Dedicated RSA key per app per day. | p4 |
| T9 | Day boundary | **Solved** | Previous day's tokens accepted for one hour. | unit |
| N18 | Issuer restart resets everyone's quota | **Solved** | Optional quota file, keyed by HMAC so it names no wallet. | issuer |
| N19 | Concurrent issuance requests overrun the quota | **Solved** | Quota reserved before any await. | issuer |
| X1 | Spam with tokens off | **Reduced** | Per-address rate limit kept in memory only, never logged. | edge |
| X3 | Large junk payloads | **Solved** | 16 KB per record. | unit |
| N20 | Memory exhaustion through a huge queue | **Solved** | Queue cap (503). | edge |
| X2 | Banning a bad actor | Decision | At issuance (wallet or code), never at record level. | — |

## Arkiv-specific

| # | Case | Status | How | Test |
| --- | --- | --- | --- | --- |
| A1 | `$creator` permanent | **Solved** | The relayer creates every record. | p1 |
| A2 | `OwnershipTransferred` shows relayer → `S` | Accepted | That is the anonymity set. | — |
| A3 | `S` has no gas | Decision | Records are create-only; updates are new records. | — |
| A4 | `permissionlessExtension` | Decision | Off. | — |
| A7 | 200 per page, no ordering, no count | **Solved** | Pinned page-through, sort in JS. | p2 |
| A8 | 128-byte string limit | **Solved** | Signature in the payload; tag is 59 chars. | unit |
| N21 | Uppercase attribute names rejected by the node | **Solved** | Lowercase enforced in client and relayer. | friction |
| N22 | SDK refuses `$createdAt` filters the node supports | **Worked around** | Raw query for batch fetches. | edge |
