# Linkage experiment

Can someone who reads Arkiv group Arkognito records by person? We measured it on Tiramisu on 9 October 2026.

## Setup

- 5 synthetic users, each with its own throwaway wallet and its own Arkognito key vault.
- Each user writes 10 records through one relayer (`k = 5`, max wait 30 s, at least 5 blocks between flushes), with the SDK's default behaviour: one record in flight per user, a random 0–15 s delay before each submission.
- Every record carries the same app attribute (`phase = linkage`) and a JSON payload with a random-length filler (0–60 bytes), so raw sizes differ.
- Ground truth (which user wrote which record) is kept only by the test, never on Arkiv.

Script: `tests/phase3.ts` (`npm run test:phase3`). Observer: `tests/observer.ts`.

## What the observer can read

Only public chain data, with these queries:

```
project = str('<project>')                     -- select key, owner, creator, createdAt, expiresAt, payload
eth_getLogs(address = 0x4400…0044, block = b)  -- EntityCreated order inside each transaction
```

## The attack

Records are grouped into batches by transaction. For each record in batch *t*, the observer guesses which record in batch *t+1* belongs to the same person, using the best signal available, in order:

1. the same `$owner` (a reused address),
2. the same position inside the transaction,
3. the same payload size and the same lifetime (`$expiresAt - $createdAt`).

Precision is the share of guessed pairs that really belong to one person.

## Results

| Measure | Result |
| --- | --- |
| Records | 50 |
| Batches | 10, every one of size 5 |
| Batches holding two records of one user | 0 |
| Distinct `$owner` values | 50 (one per record) |
| Distinct `$creator` values | 1 (the relayer) |
| Distinct payload sizes | 1 (every envelope padded to 1024 bytes) |
| Observer precision | **0.111** on 45 guessed pairs |
| Random guessing (1 of 5 users) | 0.200 |
| Without Arkognito (one owner query per wallet) | 1.000 |

The observer did no better than chance. With owners never reused, sizes padded, expiry bucketed and order shuffled, the only signal left is position, and shuffling makes position random.

## What this does not show

- The relayer itself sees IP addresses and request times (PRD R7). This experiment is about outside observers.
- Anonymity is per batch. In a quiet period a batch can be smaller than `k` after the max wait (B2); the client reports the real batch size so the user can see it.
- Content can identify a person on its own (F5). `check()` warns about timestamps, precise locations and free text, but cannot catch everything.
- 5 users is a small population. The bound is the batch size: an observer can never do better than 1 in `batch size` from these signals, but a larger set of users makes batches fill faster.
