# arkognito — Veil privacy SDK for Arkiv

Use fresh record owners, encrypted payloads and shared relayers while retaining discovery,
recovery and ownership challenges. Optional **`arkognito/semaphore`** adds anonymous group permissions.

> Experimental, Arkiv Tiramisu testnet only. This SDK reduces wallet linkage; it does not guarantee
> complete anonymity. Metadata, content, timing and network observations remain relevant. No
> independent audit has been performed. Use synthetic data for this project's demonstrations.

## Install

```bash
npm install arkognito@0.1.0 @arkiv-network/sdk@0.8.1 viem@2.57.4
```

Arkiv and viem are exact peer dependencies. Use Node 22; the integration ran on 22.23.3.
The pinned `@cloudflare/blindrsa-ts@0.4.6` declares Node `>=24`: Node 22 installs warn with
`EBADENGINE`, and `engine-strict` installs reject the mismatch despite the passing recorded tests.
This upstream compatibility issue remains unresolved.
The package is ESM. Browser bundlers must support module workers through
`new Worker(new URL(..., import.meta.url))`; the Vite worker flow was tested.
If the initial npm release is unavailable, build and pack from the
[source repository](https://github.com/soumyacodes007/Arkognito).

## Use the normal client

For Node, create a random vault and keep its recovery code private. This example expects a
running, funded local relayer; the user's record keys need no gas.

```ts
import { KeyVault, createPrivateClient } from "arkognito"

const { vault, recoveryCode } = KeyVault.random("example-feedback")
const veil = await createPrivateClient({
  app: "example-feedback",
  vault,
  relayers: ["http://localhost:8787"],
})

const record = await veil.createEntity({
  payload: new TextEncoder().encode("Synthetic feedback"),
  contentType: "text/plain",
  attributes: { type: "feedback" },
  expires: 3600,
  encrypt: true,
})
const mine = await veil.myEntities()
const ownership = await veil.proveOwnership(record.entityKey, {
  challenge: "verifier-issued-single-use-challenge",
  verifier: "reviewer-1",
})
```

Browsers can use `await WorkerVault.random(app)`, restore a worker vault, connect a signing wallet
or use a compatible passkey PRF. Preserve recovery material securely; the server cannot restore a
lost vault. Worker isolation limits secret exposure but cannot make a hostile frontend safe.

## Optional Semaphore authorization

```ts
import { createSemaphoreReader } from "arkognito/semaphore"

const veil = await createPrivateClient({
  app: group.project,
  vault,
  publicClient: reader,
  relayers: [relayerUrl],
  semaphore: { group },
})

const feed = createSemaphoreReader(reader, group, {
  trustedRelayers: [knownRelayerWallet],
})
const { accepted, rejected, spent } = await feed.readPosts()
```

An admin first enrolls the commitment from `vault.membershipCommitment(group)`.
Administration exports include `createSemaphoreGroup`, `addSemaphoreMembers` and `SemaphoreWriteQueue`.
Use the normal `createEntity()` flow after enrollment. The proof binds record content, attributes,
owner, group, scope and historical root. Relayers and readers verify off-chain; Arkiv does not
execute application smart contracts.

The reader selects the earliest valid nullifier by native creation order and retains spent status
after expiry/deletion. Verification grants no decryption access. Group, scope and nullifier are
public. Admission limits enrolled identities, not unique people.

Read the [Semaphore guide](https://github.com/soumyacodes007/Arkognito/blob/main/packages/sdk/SEMAPHORE.md)
for administration, artifacts, historical verification and operations. It ships as `SEMAPHORE.md`
in the package too.

## Limits and operations

- One process and writer queue per signing wallet.
- Persist admission journals. Pending/uncertain writes need reconciliation before retry;
  cross-host coordination and automatic journal repair are not implemented.
- Historical verification needs complete logs, receipts and past entity states. Work budgets are
  finite; long-lived applications need a durable index.
- One-time owners have no gas; a sponsored mutation lifecycle is not supplied.
- No production Anon Aadhaar/email adapter, immediate revocation or automatic group renewal is
  included. Only separate synthetic Anon Aadhaar proving was tested.
- Envelope sizes are bucketed up to 16 KiB. Membership leaves at most 25 caller attributes after
  reserved protocol attributes.
- The last recorded dependency audit found 13 advisories, without an exploitability assessment.
  Physical-passkey/mobile membership validation and an independent audit remain outstanding.

[Protocol](https://github.com/soumyacodes007/Arkognito/blob/main/spec/SPEC.md) ·
[Test evidence](https://github.com/soumyacodes007/Arkognito/blob/main/docs/semaphore-validation.md) ·
[Documentation source](https://github.com/soumyacodes007/docs) ·
[Issues](https://github.com/soumyacodes007/Arkognito/issues)

MIT licensed.
