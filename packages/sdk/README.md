# arkognito

Unlinkable ownership for [Arkiv](https://arkiv.network): each record is owned by a fresh one-time
address derived from your wallet and written by a shared relayer, so nobody can group records by
person, while you can still find and prove your own.

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
