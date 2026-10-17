# arkognito

Privacy tools for [Arkiv](https://arkiv.network): each record can use a fresh owner address and a
shared relayer to reduce wallet linkage, while you can still find and prove your own records.
This does not guarantee complete anonymity; content, metadata, timing and network observations
remain relevant.

Optional anonymous permissions use `createPrivateClient({ ..., semaphore: { group } })`.
Import `createSemaphoreGroup`, `addSemaphoreMembers`, `SemaphoreWriteQueue`, and
`createSemaphoreReader` from `arkognito/semaphore`. See the repository's
[Semaphore guide](./SEMAPHORE.md)
for group administration, browser-worker proving, self-hosted artifacts, relayer configuration,
independent verification and recovery constraints. Group membership and eligibility are distinct;
credential adapters are optional and production Anon Aadhaar integration is not supplied.

```ts
import { createPrivateClient } from "arkognito"

const ark = await createPrivateClient({ app: "my-app", wallet })
const { entityKey } = await ark.createEntity({ payload, contentType, attributes, expires })
const mine = await ark.myEntities()
const proof = await ark.proveOwnership(entityKey, { challenge, verifier: "desk-1" })
```

Peer dependencies: `@arkiv-network/sdk@0.8.1` and `viem`. In browsers the derived keys live in a
Web Worker; your bundler must support `new Worker(new URL(..., import.meta.url))` (Vite, webpack 5,
Rollup with a worker plugin).

Protocol: [spec/SPEC.md](https://github.com/soumyacodes007/Arkognito/blob/main/spec/SPEC.md).
Limits and threat model: the repository README. License: MIT.
