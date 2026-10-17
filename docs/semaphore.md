# Anonymous membership with Arkognito

Arkognito's optional Semaphore v4 module authorizes records without publishing which approved member
submitted them. It preserves the normal SDK's encrypted payloads, fresh owner addresses,
recovery, ownership challenges and shared relayer batches. It does not provide complete anonymity,
unique-human enrollment, private network traffic, or application smart contracts on Arkiv.

Dependencies are pinned to Semaphore identity/group/proof **4.14.4**, Arkiv **0.8.1**, viem **2.57.4**.
Use Node 22. Browser proving runs inside `WorkerVault`; identity secrets remain inside the worker.
Only a public commitment and the proof leave the vault. A hostile frontend can still request proofs
and observe plaintext; worker isolation does not make a compromised frontend safe.

## 1. Create an approved group

Import administration and verification helpers from `arkognito/semaphore`. The normal package entry
loads proving code only when membership is requested. An admin must exclusively control its signer,
with one shared write coordinator for every operation from that wallet. Multiple processes must not
independently sign with the same wallet.

```ts
import { KeyVault } from "arkognito"
import { createSemaphoreGroup, SemaphoreWriteQueue } from "arkognito/semaphore"

// reader and adminWallet are official Arkiv clients for Tiramisu.
const coordinator = new SemaphoreWriteQueue() // Reuse for ALL writes from this wallet.
// Synthetic demo identities only: production administrators receive commitments, never user roots.
const members = Array.from({ length: 3 }, () => KeyVault.random("example-feedback"))
const { group, txHash } = await createSemaphoreGroup({
  reader,
  wallet: adminWallet,
  coordinator,
  project: "example-feedback",
  memberCount: 3,
  // The helper predicts the group key under the writer lock before requesting commitments.
  // In production, distribute this descriptor and collect commitments from eligible users.
  members: draft => Promise.all(members.map(m => m.vault.membershipCommitment(draft))),
  rules: {
    version: 1, chainId: 7738577, depth: 3, minMembers: 3,
    maxRootAgeBlocks: 300,
    scope: { kind: "fixed", id: "feedback-round-1" },
  },
  expires: 86400,
})
```

Alternatively omit `members` and `memberCount` to create an empty group first, distribute its
confirmed descriptor, then call `addSemaphoreMembers` as users enroll. Empty/small groups cannot
authorize posts until `minMembers` is reached. `getSnapshot(block, true)` is an explicit enrollment
inspection mode; proof generation and verification always enforce the minimum.

Keep each synthetic user's recovery code privately, outside Arkiv. A membership identity is derived
with HKDF from the vault root, app, chain, project, admin and group key. A changed group creates a
different identity. Group descriptors contain `project`, `admin`, `key`, and decimal `fromBlock`.
The actual creation block replaces the draft's `fromBlock: "0"`; this field is not part of identity
derivation. For normal later enrollment, users obtain `vault.membershipCommitment(group)` and the
administrator calls `addSemaphoreMembers({ reader, wallet, coordinator, group, members, expires })`.

Groups are append-only in this version. Membership indexes are contiguous, and both group rules
and member entities are readonly and authenticated by the configured admin creator. Rotate the
group and relayer policy for revocation; deleting a member is not immediate cryptographic revocation.
Old snapshots remain usable within `maxRootAgeBlocks`. Renew group/member lifetimes deliberately;
the module does not run a renewal service.

Scope can instead be `{ kind: "window", blocks: 1800 }`. Windows use chain block numbers, **not wall
clock hours**. Include a distinct fixed scope ID for each poll; use a new group for changed rules.
One identity has one accepted record per group/scope. This limits enrolled identities, not people.

## 2. Configure a relayer

Write an array of trusted group descriptors to a local JSON file and configure:

```dotenv
SEMAPHORE_GROUPS_FILE=data/groups.json
SEMAPHORE_JOURNAL=data/semaphore-admissions.jsonl
SEMAPHORE_HISTORY_BLOCKS=10000
# Optional: comma-separated additional trusted relayer wallet addresses.
SEMAPHORE_TRUSTED_RELAYERS=
```

Existing relayer keys and RPC access keys remain server-side. Each configured project requires its
group proof, even when blind tokens are disabled. A valid membership proof replaces blind-token
redemption for that project. Other projects retain their existing token policy. Unconfigured
membership requests are rejected. There is one configured group per project in this MVP.

Persist `data/` across restarts; do not put it on Arkiv or expose it through the web server. The
admission journal stores public nullifier reservations and receipts, without IPs, credentials or
user roots. Sharing a journal coordinates cooperating relayers **on one host**; all participants
must use it. This is not distributed consensus. Keep one process per signing wallet. Independent
relayers with separate journals can publish duplicates; the independent reader still deduplicates
within its explicitly trusted creator set.

Reservations are flushed before enqueueing. A timeout, expired scope, batch rejection, process crash
or uncertain broadcast retains the reservation. There is no automatic release or resubmission.
A corrupt journal or stale lock fails closed. Operators must reconcile original signed transaction
history, pending nonces and receipts before any manual repair; an empty current query is not proof
that no write happened. Restore the journal from a trusted backup, never delete it to clear errors.
Automatic operator reconciliation and cross-host coordination are not implemented.

Membership batches require real valid member submissions for their requested size. Arkognito cannot
forge Semaphore proofs for cover records, so synthetic cover padding is disabled for these records.
Proofs, group, scope and nullifier are public; repeated attempts in the same scope are intentionally
linkable. Network timing, public app metadata, traffic and small groups can still identify people.

## 3. Submit with the regular client

```ts
import { createPrivateClient, WorkerVault } from "arkognito"

const vault = await WorkerVault.fromRecoveryCode(savedRecoveryCode, "example-feedback")
const arkognito = await createPrivateClient({
  app: "example-feedback", vault, relayers: [relayerUrl], publicClient: reader,
  semaphore: { group },
})
const result = await arkognito.createEntity({
  payload: new TextEncoder().encode("Synthetic feedback"),
  contentType: "text/plain", attributes: { type: "feedback" },
  expires: 3600, encrypt: true,
})
const mine = await arkognito.myEntities() // Local tag discovery and decryption still work.
const ownership = await arkognito.proveOwnership(result.entityKey, {
  challenge: "application-issued-random-challenge", verifier: "reviewer-1",
})
vault.terminate() // When the app closes this session.
```

Wallet, passkey PRF and random/recovery vaults all implement the same membership operations. Custom
vaults must implement `membershipCommitment(group)` and `proveMembership(witness)`. Enrollment is
separate: creating a commitment does not add it to a group. Preserve recovery material securely;
the server cannot restore a lost root. Physical passkey/browser compatibility requires device tests.

Five attribute names are reserved: `zkgroup`, `zkscope`, `zknullifier`, `zkroot`, `zkblock`.
Together with `project` and `vtag`, these leave at most 25 caller attributes under Arkiv's 32 limit.
The original envelope signature covers all attributes; the Semaphore message binds typed app
attributes, tag, bytes, encryption mode, app, owner, expiry, group, chain, scope and root block.
Member records are readonly but can still be transferred, deleted and extended by their owner.
Do not automatically retry `createEntity` after a membership error: reconcile the reported request
or record first. Automatic cross-relayer failover is disabled once a membership submission starts.

## 4. Independently verify

```ts
import { createSemaphoreReader } from "arkognito/semaphore"

const feed = createSemaphoreReader(reader, group, {
  trustedRelayers: [knownRelayerWallet], // Complete, explicitly trusted creator set.
  maxHistoryBlocks: 10000,
  maxPages: 100,
})
const { accepted, rejected, spent, snapshot } = await feed.readPosts()
// Or: arkognito.readPosts() uses the configured relayer addresses.
```

The reader fetches native creation logs from group creation through a pinned head, authenticates
successful receipts and readonly flags, and loads records at their creation blocks. It rebuilds
ordered admin membership at each proof's `rootBlock`, checks ownership signatures and all proof
bindings, and picks the earliest valid nullifier by `(block, transactionIndex, logIndex)`.
Deleted/expired winners retain spent status and cannot promote later duplicates. `accepted` is the
live verified feed; `spent` also retains vanished canonical publications. Ciphertext remains
ciphertext: feed verification grants no decryption access.

This requires complete publication history and historical entity state from the provider. Query/log
budgets, unavailable history, inconsistent receipts and RPC errors fail closed with
`VerificationUnavailable`; they must not be displayed as "no posts". The RPC remains a trust and
availability dependency; this is not a cryptographic proof that a provider returned every log.
Long-lived deployments need an authenticated durable index/checkpoint service, not ever-growing
rescans. Defaults deliberately bound work and may need adjustment for a larger group/history.

## Proving artifacts

`@semaphore-protocol/proof@4.14.4` uses its selected **4.13.0** artifacts. Default artifact retrieval
and Node caching are supplied by the upstream library. To self-host, pass
`semaphore: { group, snarkArtifacts: { wasm: wasmUrl, zkey: zkeyUrl } }`. Browser URLs need CORS or
same-origin hosting; Node also accepts the upstream supported byte/path inputs. Use files for the
configured depth. For depth 3, tested files are:

| File | SHA-256 |
|---|---|
| `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.wasm` | `48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2` |
| `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.zkey` | `c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3` |

## Credential integrations

Anon Aadhaar is an optional **admission adapter**, not a core dependency. An app must independently
verify its credential proof, issuer/key policy, freshness, audience and binding to the target random
commitment before its admin admits a member. Preventing repeated enrollment is a separate off-chain
policy. There is no permissive placeholder credential verifier or public "approve me" endpoint.
Only synthetic Anon Aadhaar test proving has been tested separately; the complete adapter is not
implemented. ZK Email is deferred. Under this project's rule, real credentials, their proofs and
credential-derived nullifiers stay off Arkiv, even when hashed. Demo records are synthetic only.

## Tests

`npm test` includes real Semaphore proof/negative tests and durable-journal controls.
`npm run test:semaphore:live` is opt-in: it uses only `SPIKE_PRIVATE_KEY` from gitignored
`spikes/.env`, a previously funded throwaway Tiramisu key, and bounds admitted transaction
fee/value to 0.05 testnet GLM. It writes synthetic groups/reports, runs actual SDK and browser-worker
flows against a temporary page in the existing demo, and removes that page in `finally`.
Public evidence belongs in `docs/semaphore-validation.md`; raw submissions, recovery codes and
local journals remain under ignored `spikes/state/`. No service is deployed or published by this test.
