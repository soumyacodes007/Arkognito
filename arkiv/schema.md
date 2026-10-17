# Arkognito entity schema

As built and tested on Tiramisu (chain 7738577) with `@arkiv-network/sdk` 0.8.1. Attribute names are
lowercase only: the node rejects uppercase (see `friction.md`).

| Type | Owner | Creator | Attributes | Payload | Expiry |
| --- | --- | --- | --- | --- | --- |
| App record (any schema) | `S`, a one-time derived address | A relayer | The app's own, plus `project` = the app's project and `vtag` (59-char encrypted key reference, opens only for the owner) | Arkognito envelope, padded to 512 B / 1 KB / 4 KB / 16 KB, optionally encrypted | App's choice rounded up to 1 h, 1 d, 7 d, 30 d or 90 d |
| `arkognito.issuerKey` | Issuer wallet | Issuer wallet | `project`=`arkognito-7f3k`, `type`, `app`, `epoch` (i32, UTC day) | `{ spki, scheme }`, RSA-2048 public key | End of the day + 2 days |
| `arkognito.spent` | Relayer | Relayer | `project`, `type`, `app`, `epoch` (i32), `tokenid` (bytes32 = sha256 of the prepared token message) | Empty | End of the token's day + 1 day |
| `arkognito.relayer` | Relayer | Relayer | `project`, `type`, `version`, `url`, `minbatch` (i32), `tokens` (bool), `ohttpkey` (bytes32, OHTTP gateway key) | `{ url, version }` | 150 blocks (~5 min), extended every 2 min |

## Record envelope

```json
{ "v": 1, "app": "...", "ct": "<app content type>", "exp": 2592000, "enc": 0, "data": "<base64>", "sig": "0x...", "pad": "000..." }
```

`sig` is S's EIP-191 signature over
`keccak256(abi.encode("arkognito/envelope/v1", app, ct, uint64 exp, uint8 enc, data, canonicalAttributes))`.
Readers check `recover(sig) == $owner` and that `$expiresAt - $createdAt` matches `exp` within 30 blocks.

## Queries behind each claim

| Claim | Query |
| --- | --- |
| Without Arkognito, one query lists a wallet's records | `project = str('arkognito-demo-sketch') AND $owner = addr(<wallet>)` |
| With Arkognito, each owner holds one record | same query on any `S` returns 1; on the user's wallet returns 0 |
| Arkognito records share one creator | `project = str(<app>) AND $creator = addr(<relayer>)` |
| `myEntities()` (D1) | `project = str(<app>)` pinned `atBlock`, selecting key, owner, creator, createdAt, attributes; tags opened locally; then `… AND $createdAt = u64(<block>) AND $creator = addr(<relayer>)` per batch, plus 2 cover batches |
| Today's issuer key (T1) | `project = str('arkognito-7f3k') AND type = str('arkognito.issuerKey') AND app = str(<app>) AND epoch = <day>` created by the issuer; more than one result means equivocation |
| Token already spent (T4) | `project = str('arkognito-7f3k') AND type = str('arkognito.spent') AND tokenid = bytes32(<id>)` |
| Live relayers (R8) | `project = str('arkognito-7f3k') AND type = str('arkognito.relayer')`; trust only each entity's `$creator` |

## Optional Semaphore v1 entities

All fixtures are synthetic. Public commitments derive from random/private vault roots, never
personal credentials. Group descriptors identify a trusted admin, project, key and creation block.

| Entity | Attributes | Payload | Creator / flags / lifetime |
|---|---|---|---|
| Group | `project: str`, `type: str('veil.group')` | `{version:1,chainId:7738577,depth,minMembers,maxRootAgeBlocks,scope}` | Allowlisted admin; readonly; caller-chosen lifetime |
| Member | `project: str`, `type: str('veil.member')`, `group: str(groupKey)`, `memberindex: i32`, `commitment: u256` | `{version:1}` | Same admin; readonly; caller-chosen lifetime |
| Authorized app record | Original app attributes plus `project`, `vtag`, `zkgroup: str`, `zkscope: str`, `zknullifier: str`, `zkroot: str`, `zkblock: u64` | Original signed/padded envelope plus `membership:{group,rootBlock,proof}` | Trusted relayer creates and transfers to fresh owner in one batch; readonly; normal expiry bucket |

The proof contains depth, decimal root/nullifier/message/scope and eight curve-point coordinates.
Scope and message are domain-separated SHA-256 digests encoded as decimal integers. Group scopes
are fixed poll IDs or block-number windows, according to immutable rules. See
[`docs/semaphore.md`](../docs/semaphore.md) and exported `membershipMessage`/`semaphoreScope` for the
exact canonical encoding. The five `zk*` attributes are reserved and count toward the 32 limit.

Queries pin `.atBlock(snapshot)` and walk every page at 200/page. Group lookup uses
`project = str(project) AND $key = key(groupKey)` with `.createdBy(admin)`. Members use project,
`type = str('veil.member')`, and `group = str(groupKey)` with `.createdBy(admin)`; sort contiguous
`memberindex` values in JS. Posts use project, `zkgroup`, optionally `zkscope` or `zknullifier`,
and the trusted relayer creator. Native creation logs plus authenticated receipts recover each
publication at its creation block. Canonical valid nullifiers use block/transaction/log order;
deleted or expired winners remain spent and do not promote duplicates.

The SDK's independent reader fails closed when required history is unavailable or budgets are
exhausted. It relies on the provider for complete logs/state. Admission journals, credential proofs,
credential-derived nullifiers, roots/secrets and user-to-wallet mappings are never published.
