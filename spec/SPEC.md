# Arkognito protocol, version 1

Enough detail to write a compatible client or relayer without reading our code. The reference
implementation is `packages/sdk` (client) and `packages/relayer` (relayer, issuer, OHTTP relay).
Every edge case and how it is handled: [docs/edge-cases.md](../docs/edge-cases.md).

Network: Arkiv Tiramisu, chain id `7738577`, entity registry `0x4400000000000000000000000000000000000044`,
block time 2 s. Arkognito's own entities carry `project = "arkognito-7f3k"`. Attribute names are lowercase
(`^[a-z][a-z0-9._-]*$`): the node rejects uppercase.

## 1. Keys

1. The user's wallet signs this EIP-712 message once per app:

   ```
   domain:  { name: "arkognito", version: "1", chainId: 7738577 }
   types:   ArkognitoKey { purpose: string, app: string, chainId: uint256 }
   message: { purpose: "arkognito key v1", app: <app>, chainId: 7738577 }
   ```

   The client refuses a wallet whose signatures are not deterministic. By default it signs twice
   the first time a device sees a wallet for an app, refuses on a mismatch, and stores
   `fp = HKDF-SHA256(signature, info = "arkognito/wallet-check/v1", L = 16)` under
   `arkognito:wallet-check:<chainId>:<app>:<lowercase address>` (localStorage in browsers). Later it
   signs once and refuses if the fingerprint differs. `verifyDeterminism: "always"` signs twice every
   time; `"never"` signs once. Smart-contract wallets (account with code) are refused.

2. `root = HKDF-SHA256(ikm = signature bytes (65), salt = none, info = "arkognito/root/v1/" + app, L = 32)`.
   Random-root mode: `root` is 32 random bytes; recovery code `"arkognito1-" + hex(root)`.

   Passkey mode (no wallet): the WebAuthn PRF extension evaluated with
   `salt = sha256("arkognito/passkey/v1|" + app)` returns a 32-byte `secret`, and
   `root = HKDF-SHA256(secret, info = "arkognito/root/v1/passkey/" + app, L = 32)`. Creating the passkey
   also returns the recovery code `"arkognito1-" + hex(root)`, since losing the passkey loses the keys.

3. A key reference is `(kind, id)` with `kind ∈ {record, scope}` and a 15-byte `id`, or `kind = inbox`
   with a 32-byte `id` (section 3a):
   - a record gets a fresh random `id` (no counters: nothing can be reused after records expire,
     and two devices cannot collide);
   - a scope's `id = sha256("arkognito/scope/" + name)[0..15]`, so all its records share one owner on purpose.
   - the issuer identity is `k = HKDF(root, info = "identity/issuer/v1", 48)` reduced the same way. It
     is outside the `record/` and `scope/` labels, so no key reference reaches it, and it is used only
     to sign token-issuance requests.

4. The key for a reference:

   ```
   okm = HKDF-SHA256(ikm = root, salt = none, info = kind + "/" + hex(id), L = 48)
   k   = (big-endian integer of okm  mod  (n - 1)) + 1        n = secp256k1 order
   ```

   The record's owner `S` is the address of `k`.

5. Every record carries its reference, encrypted, in the attribute `vtag`:

   ```
   tagKey = HKDF-SHA256(root, info = "arkognito/tag/v1", L = 32)
   plain  = kind byte (0 = record, 1 = scope) || id                       (16 bytes)
   vtag   = base64url(iv(12 random bytes) || AES-256-GCM(tagKey, iv, plain, aad = "arkognito/tag/v1|" + app))
   ```

   Always 44 bytes (59 characters), with a fresh IV every time.

6. Payload encryption (optional): `dataKey = HKDF-SHA256(root, info = "arkognito/data/v1/" + kind + "/" + hex(id), L = 32)`,
   ciphertext `iv(12) || AES-256-GCM(dataKey, iv, payload)`.

## 2. Record envelope

The record payload is UTF-8 JSON with keys in this order:

```json
{ "v": 1, "app": "<app>", "ct": "<app content type>", "exp": <seconds>, "enc": 0, "data": "<base64>", "sig": "0x…", "pad": "000…" }
```

- `exp`: lifetime in seconds, rounded **up** to `3600, 86400, 604800, 2592000, 7776000`. Longer is refused.
- `enc`: `1` when `data` is the encrypted payload (section 1.6), else `0`.
- `sig`: `S`'s EIP-191 signature (`personal_sign` of the raw 32 bytes) over

  ```
  digest = keccak256(abi.encode(
    string "arkognito/envelope/v1", string app, string ct, uint64 exp, uint8 enc, string data, string canonicalAttributes))
  ```

  `canonicalAttributes` = `JSON.stringify` of `[name, type, value]` triples sorted by name, values
  normalised to their Arkiv type (bare number → `i32`, bigint → `u256`, string → `str`,
  boolean → `bool`) and written as strings; `addr`, `key`, `bytes32` lowercased. The attributes
  signed are the ones written on chain, including `project` and `vtag`.
- `pad`: a run of `"0"` making the UTF-8 length of the whole JSON exactly 512, 1024, 4096 or 16384
  bytes. The bucket is chosen as if the payload were encrypted (28 bytes more), so encrypted and
  plain records of the same input are the same size. Larger records are refused.

The entity: `contentType = "application/json"`, attributes = the app's plus `project` and `vtag`,
lifetime `exp` seconds.

### Verifying a record

1. the payload parses as a v1 envelope (and `app` matches, when known);
2. `recover(sig, digest(envelope, on-chain attributes)) == $owner`;
3. `|($expiresAt - $createdAt) - exp / 2| <= 30` blocks;
4. optionally `$creator` is a known relayer.

## 3. Finding your records

1. List the app, pinned to one block: `project = str(<project>)`, selecting `key`, `owner`,
   `creator`, `createdAt` and `attributes`, every page with the same `atBlock`. No user address
   or record key appears in the query.
2. Trial-decrypt every `vtag`. A tag that opens names a key reference; derive its address and
   require it to equal the record's owner.
3. Fetch payloads for whole batches only: `project = … AND $createdAt = u64(<block>) AND $creator = addr(<relayer>)`
   for each batch holding a record of yours, plus 2 other batches at random as cover. Verify each record.

When the app has at most `fetchAllUnder` records (default 500), step 3 instead downloads every record
of the project at one block, so the read says nothing about which records are yours.

After writing, a client confirms its record the same way (the whole batch, never one key), reading
again for up to 10 s if the RPC node has not caught up with the block yet. If a relayer fails to
answer, the client looks for its own `vtag` in a fresh listing before retrying anywhere else, so a
relayer that wrote and then crashed causes no duplicate.

## 3a. Inbox records (send to user)

A record someone else writes for you, owned by a one-time address only you control (stealth
addresses on secp256k1, as in ERC-5564).

```
k_spend = key(root, "identity/inbox-spend/v1"), k_view = key(root, "identity/inbox-view/v1")   (section 1.4 reduction)
inbox address = "arkognito-inbox1:" || hex(compressed K_spend) || hex(compressed K_view)

sender:  r random, R = rG with even y (else r = n - r);  shared = x(r · K_view)
         c      = scalar(shared, "arkognito/inbox/owner/v1|" + app)        owner = address(K_spend + cG)
         k_sig  = scalar(shared, "arkognito/inbox/sign/v1|" + app)         signs the envelope
         dataKey = HKDF(shared, "arkognito/inbox/data/v1|" + app, 32)      payload always encrypted
         viewTag = HKDF(shared, "arkognito/inbox/viewtag/v1|" + app, 1)
         vtag   = base64url(x(R) (32) || viewTag (1) || 11 random bytes)   44 bytes, like every tag
recipient: for each tag that does not open as a normal tag, shared = x(k_view · R); skip unless the
         view tag matches; the owner key is k_spend + c; verify the envelope against address(k_sig·G).
scalar(ikm, info) = (HKDF-SHA256(ikm, info, 48) mod (n - 1)) + 1
```

The submission carries `inbox: true`; the relayer then requires a valid envelope signature that
does **not** recover to `owner`, and a normal submission's signature must recover to `owner`. An
inbox record is therefore recognisable as one, but not who it is for, who sent it or what it says.
A tag's first 32 bytes are always a valid curve x-coordinate, where a normal tag's are only half the
time: over many records this tells inbox tags apart as well, which the signature already does.

## 4. Relayer HTTP API

JSON bodies, open CORS. Relayers must not log request IPs.

| Method | Path | Body / answer |
| --- | --- | --- |
| `GET` | `/v1/info` | `{ address, version: "arkognito-relayer/1", chainId, minBatch, maxWaitMs, minIntervalBlocks, tokensRequired, issuer?, issuerUrl?, maxMinAnonymity, maxHoldMs, ohttpKey?, coverMinBatch? }` |
| `POST` | `/v1/records` | `{ app, owner, envelope, attributes, expSeconds, token?, minAnonymity?, maxHoldMs?, inbox? }` → `202 { id }` |
| `GET` | `/v1/records/:id` | `{ id, state: "queued" \| "written" \| "failed", position?, entityKey?, txHash?, block?, batchSize?, cover?, error? }` |
| `POST` | `/v1/ohttp` | an encapsulated request (section 5) → an encapsulated response |
| `GET` | `/healthz` | `{ ok, address, queue, batches, lastFlushBlock, heartbeat, lastBeat, balanceGlm, doubleSpendsDetected }` |

`attributes` on the wire: `{ <name>: { type, value } }`, `u64`/`u256` values as decimal strings.

A relayer refuses (`400`) a submission unless: `owner` is an address other than its own; the
envelope is padded to a bucket; `expSeconds` is a bucket and equals `exp`; `app` equals the
envelope's; every attribute name is valid; `project` is present; at most 32 attributes;
`minAnonymity` (if given) is 1…`maxMinAnonymity` and `maxHoldMs` ≤ the relayer's; and the
envelope signature recovers to `owner` (with `inbox: true`: is valid and recovers to anything else). Tokens on: none → `402`, bad or spent → `403`. Tokens off:
more than `RATE_LIMIT_PER_MIN` requests a minute from one address → `429` (counted in memory only).
Queue full → `503`.

### Batching

- A batch is up to `maxBatch` queued records, minus any whose `minAnonymity` exceeds the batch size
  (repeat until stable). Flush when it has `minBatch` records or its oldest has waited `maxWaitMs`,
  and never before `lastFlushBlock + minIntervalBlocks`. A record whose hold expires without a big
  enough batch fails and is not written.
- Shuffle records (Fisher–Yates, cryptographic randomness), and shuffle spent markers separately.
- `predictEntityKeys(relayer, n + m)`, then one `executeBatch`: creates `[records…, markers…]` with
  the predicted salts, and `ownershipChanges` giving record `i` to its `owner`.
- One writer per relayer wallet. Stale prediction: predict again (up to 3 times). Any other failure:
  split the batch in halves and retry each.
- Cover (optional, `COVER_MIN_BATCH = m`): a batch of fewer than `m` records is filled with cover
  records. Each copies a random **encrypted** record of the batch: same app, attributes except
  `vtag`, content type, expiry bucket and ciphertext length; random ciphertext, a random 44-byte
  `vtag`, a fresh owner that signs it (or, copying an inbox record, a separate signing key), and with
  tokens on a spent marker with a random token id. A batch of plaintext records gets no cover: random
  bytes cannot pass for someone's plaintext.
- `written` status carries `block`, `batchSize` (cover included) and `cover` (how many were cover).

### Client behaviour

- One write in flight per client, and per app across browser tabs (Web Locks).
- Random delay before each submission (default 0–20 s).
- Give up on a relayer when its `position` has not improved for `3 × (maxWaitMs + 2 s × minIntervalBlocks) + 30 s`
  (or `maxHoldMs`, if longer).

### Discovery

```
project = "arkognito-7f3k", type = "arkognito.relayer", url, version, minbatch (i32), tokens (bool), ohttpkey (bytes32)?
lifetime 150 blocks, extended every 2 minutes; settings patched on restart
```

Trust only the heartbeat's `$creator` as the relayer's address, and use a relayer only if its
`/v1/info` reports that same address.

## 5. Oblivious HTTP

A client may send every relayer call through an OHTTP relay run by someone else. Encapsulation
follows RFC 9458 §4 with HPKE base mode, KEM X25519-HKDF-SHA256 (`0x0020`), KDF HKDF-SHA256
(`0x0001`), AEAD AES-128-GCM (`0x0001`), key id `1`. The inner message is JSON
`{ method, path, body? }` / `{ status, body }`, so the labels are Arkognito's own:

```
request:  hdr = keyId || kemId || kdfId || aeadId
          info = "message/arkognito-ohttp request" || 0x00 || hdr
          enc, ct = SealBase(gatewayKey, info, aad = "", inner request)
          sent:  hdr || enc || ct
response: secret = context.Export("message/arkognito-ohttp response", 16)
          nonce  = 16 random bytes
          prk    = HKDF-Extract(salt = enc || nonce, secret)
          key    = HKDF-Expand(prk, "key", 16),  aeadNonce = HKDF-Expand(prk, "nonce", 12)
          sent:  nonce || AES-128-GCM(key, aeadNonce, inner response)
```

- Client → relay: `POST <relay>/ohttp`, header `x-arkognito-target: <relayer url>`, body = encapsulated request.
- Relay → relayer: `POST <relayer>/v1/ohttp` with only the body; no client address or headers.
- The relay forwards only to `https` targets on public hosts whose live heartbeat publishes an
  `ohttpkey` and which answer `/v1/info` with the heartbeat creator's address and that key (no redirects).
- The gateway key is read from the heartbeat on Arkiv, never from the relay. Anyone can publish a
  heartbeat claiming any URL, so the client tries every key claimed for a URL and accepts the one
  whose decrypted `/v1/info` names that heartbeat's creator.
- A relayer derives its gateway key from its own private key (HKDF, label `arkognito/ohttp/v1`), so it
  survives restarts.

## 6. Ownership proof

```
domain:  { name: "arkognito", version: "1", chainId }
types:   OwnershipProof { entityKey: bytes32, challenge: string, verifier: string, expiresAt: uint64 }
```

Signed by `S`. The verifier checks the challenge and its own name, that `expiresAt` (unix seconds)
has not passed, that the signature recovers to the claimed owner, and that the entity's `$owner`
on chain is that address.

A key signs only Arkognito envelopes (section 2) and ownership proofs; implementations should not expose
a general "sign these bytes" for derived keys.

## 7. Rate-limit tokens

Scheme: RSA blind signatures, `RSABSSA-SHA384-PSS-Randomized` (RFC 9474), 2048-bit keys.

**Days.** `epoch = floor(unix_ms / 86 400 000)`. Previous-day tokens are accepted for the first hour of a new day.

**Issuer key.** One per app per epoch, published by the issuer's wallet:

```
project = "arkognito-7f3k", type = "arkognito.issuerKey", app, epoch (i32)
payload { spki: <base64 SubjectPublicKeyInfo>, scheme: "RSABSSA-SHA384-PSS-Randomized" }
lifetime: until the end of epoch + 2 days
```

Read from Arkiv (filtered by the issuer as `$creator`), never from HTTP. Two such entities for one
app and epoch: the issuer equivocated; refuse it.

**Issuance.**

```
POST /v1/tokens/issue  { app, epoch, wallet, blinded: [base64…], ts, walletSignature, attestation? }

wallet          = the issuer identity (default) or the user's wallet (tokenIdentity: "wallet")
walletSignature = personal_sign by that address over:
  "arkognito tokens v1\napp: <app>\nday: <epoch>\ncount: <n>\nrequest: <0x sha256 of the blinded list joined by ','>\nts: <ts>"
```

Each token message is 32 random bytes, prepared as `32 random bytes || message` (64 bytes) and
blinded. The issuer checks the signature, that `ts` is within 5 minutes, and the quota, then returns
`{ blindSignatures: [base64…], remaining }`. The quota is per `wallet` field per app per day, or, when the
issuer requires attestation codes, per code (a code is good for one day). `GET /v1/issuer/key?app=&epoch=`
asks the issuer to publish today's key.

Clients fetch tokens at session start, keep them across sessions, spend the oldest first, and never
spend a token younger than 60 s.

**Redemption.** `token = { epoch, nonce: 0x<prepared 64 bytes>, signature: base64 }`. The relayer
verifies it, computes `tokenid = sha256(prepared)`, refuses it if a `arkognito.spent` entity with that id
exists or it is in flight, and writes the marker in the same transaction as the record:

```
project = "arkognito-7f3k", type = "arkognito.spent", app, epoch (i32), tokenid (bytes32)
empty payload; lifetime until the end of epoch + 1 day
```

It checks the spent list again right before writing, and periodically scans it for any id recorded
twice (two relayers passing in the same block).

## 8. What never goes on Arkiv

The wallet signature, the root key, any derived key, the link between a wallet and its `S`
addresses, issuer private keys, relayer or relay logs, quota records and attestation codes.
