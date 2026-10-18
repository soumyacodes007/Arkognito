# Campus Voice

**Report a professor without being identified, and still be believed.** A story-mode demo of
Arkognito with Semaphore on Arkiv's Tiramisu testnet. Every person, professor and report in it is
invented.

| Chapter | What happens | What it shows |
|---|---|---|
| 1. Join through the student union | Scan a synthetic Anon Aadhaar **test** card; the browser makes a zero-knowledge proof (valid card, over 18, one-per-person code) bound to new membership commitments; the union verifies it and adds the commitments | One person, one membership, and the union never sees a name or number |
| 2. Report Professor A | A Semaphore proof is made in the browser; the report is encrypted for the committee and sent through the shared relayer | Only members can report |
| 3. What anyone can see | The record on Arkiv: sender = shared relayer, owner = one-time address, content = ciphertext. "Verify it yourself" re-checks the Semaphore proof in the browser against the union's list | Nothing points to the student, and anyone can check the proof |
| 4. Try to report again | A second report on the same professor is refused (`409 Valid nullifier already published`) | One student, one report per professor |
| 5. Report Professor B | Another report, another owner | The student's reports can't be linked to each other |
| 6. Your classmates speak up | Four classmates report Professor A; the committee decrypts and counts | **5 reports, 5 different students**, none identified |
| 7. Months later, on a new phone | Wipe, restore from the code, find the reports, prove ownership to the committee | Authorship can be proved later, by choice |

Each chapter links to the Arkiv explorer for the records and transactions it creates.

## Run it

```bash
npm install
npm run dev -w campus-voice
```

Then open http://localhost:5180. This starts the story server (port 8790), the relayer (8791) and the
web app (5180, which proxies `/api`, `/relay` and `/rpc` to them).

Needs, in the repo's `.env`: funded `TEST_RELAYER_A_PRIVATE_KEY` (the shared relayer) and
`TEST_RELAYER_B_PRIVATE_KEY` (the student union). Optional, in `apps/campus-voice/.env`
(gitignored): `CAMPUS_ARKIV_ACCESS_KEY`, used server-side for every Arkiv read. Without it, reads use
Arkiv's anonymous budget, which a few full runs can exhaust (`429 ANON_COST_LIMITED`).

The browser proves with the depth-3 Semaphore files in `spikes/s1-semaphore-node/artifacts`
(digest-checked by `npm run test:semaphore:live`).

The same story without a browser, as a test with 16 checks:

```bash
npm run flow -w campus-voice
```

The Anon Aadhaar join on its own (generate a test card, prove it, the union's checks; about 3 minutes):

```bash
npx tsx --conditions=arkognito-source apps/campus-voice/server/try-aadhaar.ts
```

## Anon Aadhaar, test mode only

- The story server makes synthetic test cards: Anon Aadhaar's own sample card (`test.json`) with a
  random photo and a fresh timestamp, re-signed with Anon Aadhaar's **published test key**. A new photo
  is a new identity, because Anon Aadhaar derives its nullifier from the photo.
- The browser reads the card and proves it in a Web Worker with `@anon-aadhaar/core` 2.4.3. The first
  proof downloads the chunked proving key (282 MB) and caches it in IndexedDB; a proof took about 80
  seconds in Chrome on 18 Oct 2026. The card's data never leaves the browser.
- The union accepts a proof only if it is signed by the test key (a real Aadhaar is refused), uses
  this app's nullifier seed, shows the holder is over 18, is less than 24 hours old, and is bound
  (through its signal) to exactly the membership commitments it is asked to add. A card that already
  joined is refused.
- Cards, proofs and Anon Aadhaar nullifiers never go on Arkiv. The union keeps used nullifiers in
  its local `.state/` only.

## Who plays whom

| Role | Where it runs | Holds |
|---|---|---|
| You, the student | The browser (Arkognito's `WorkerVault`) | Recovery code, membership identities, report keys |
| Student union | Story server, wallet `TEST_RELAYER_B` | Admits commitments; never sees reports' authors |
| Shared relayer | Story server, wallet `TEST_RELAYER_A` | Checks membership proofs and nullifiers, pays gas |
| Four classmates | Story server (synthetic recovery codes in `.state/`) | Their own vaults; admitted at setup without their own Anon Aadhaar proofs, to keep resets quick |
| Complaints committee | Story server | The X25519 key that opens reports |

## Honest limits

- **One group per professor.** A Semaphore scope is fixed per group, and a relayer accepts one group
  per project, so "once per professor" means one group (and project) per professor.
- **Small groups.** Depth-3 groups hold 8 members; "Start a new story" makes fresh groups.
- **Timing.** The demo relayer sends each report alone (`MIN_BATCH=1`) for speed. A real deployment
  batches reports so timing does not link a sender to a record.
- **The union learns only "a valid test card, over 18, this one-per-person code".** It cannot link a
  commitment to any report.
- **Classmates skip Anon Aadhaar.** Only the visitor joins the full way; making four more proofs
  would add minutes to every "Start a new story".
- Reports are encrypted to the committee in the app (`encryptShare`), so the student still owns the
  record and can prove it; Arkognito's own `encrypt: true` would make it readable only by the student.
