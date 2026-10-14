# Deploying the public demo (Railway + Vercel)

Step-by-step for putting Arkognito online so anyone can try the demo from a link. About 30 minutes.

Public demo: [Sketch App](https://arkognito.vercel.app),
[observer view](https://arkognito.vercel.app/observer.html), and
[private sketches](https://arkognito.vercel.app/sketch-private.html).

Live relayer health checks:
[relay-1](https://relay-1-production-80f5.up.railway.app/healthz) and
[relay-2](https://relay-2-production-6f0f.up.railway.app/healthz).

What you will end up with:

| Piece | Where | What it does |
| --- | --- | --- |
| `relay-1` | Railway | Relayer **and** token issuer |
| `relay-2` | Railway | Second relayer (failover, accepts relay-1's tokens) |
| `ohttp-relay` | Railway (optional) | Hides users' IPs from the relayers. The demo does not use it yet: skip it for now |
| Demo site | Vercel | The Sketch App (public vs private), observer view, wallet check |

The demo site needs **no relayer URLs**: it finds the relayers through their heartbeat entities on
Arkiv. As soon as relay-1 and relay-2 are up with `https` URLs, the site uses them.

## Before you start

You need, from the project owner, **through a password manager or a private channel, never in a
chat, an issue or the repo**:

- `RELAYER_1_PRIVATE_KEY`, `RELAYER_2_PRIVATE_KEY`, `ISSUER_WALLET_PRIVATE_KEY`: the three funded
  testnet wallets (about 2 GLM each).
- `ISSUER_WALLET_ADDRESS`: the issuer wallet's public address.
- `ISSUER_RSA_SEED`: 32 bytes of hex; the issuer's daily keys derive from it.
- `ARKIV_ACCESS_KEY`: the Arkiv Hub API key (optional, gives higher RPC rate limits).

Alternatively make your own: clone the repo, `npm ci && npm run setup`, fund the three printed
addresses at the [faucet](https://hub.arkiv.network/faucet) (it gives 0.1 GLM a day per wallet;
ask the owner for a transfer if you need more), and copy the values from your `.env`.

> **One wallet, one place.** Once a relayer wallet runs on Railway, do not also run it on a laptop
> (`npm run dev:relayers`, tests). Two processes on one wallet make each other's transactions fail.

## 1. Railway: relay-1 (relayer + issuer)

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** →
   `soumyacodes007/Arkognito`. Railway reads `railway.json`: Dockerfile build, `/healthz` health
   check, restart always.
2. Rename the service to `relay-1`.
3. **Settings → Networking → Generate Domain**, target port **8787**. Copy the URL, for example
   `https://relay-1-production.up.railway.app`.
4. **Volumes → New Volume**, mount path **`/data`** (keeps token quotas across restarts).
5. **Variables** (Raw editor):

```env
ROLE=relayer
PORT=8787
RELAYER_NAME=relay-1
RELAYER_PRIVATE_KEY=<RELAYER_1_PRIVATE_KEY>
RELAYER_PUBLIC_URL=https://<relay-1 domain from step 3>
REQUIRE_TOKENS=on
ISSUER=on
ISSUER_WALLET_PRIVATE_KEY=<ISSUER_WALLET_PRIVATE_KEY>
ISSUER_RSA_SEED=<ISSUER_RSA_SEED>
ISSUER_QUOTA_FILE=/data/issuer-quota.json
TOKENS_PER_DAY=20
MAX_WAIT_MS=20000
ARKIV_ACCESS_KEY=<ARKIV_ACCESS_KEY>
RAILWAY_RUN_UID=0
```

Why some of these:

- `PORT=8787` must match the domain's target port, or Railway answers 502.
- `RELAYER_PUBLIC_URL` must be the **https** domain: it is announced on Arkiv, and browsers only use https relayers.
- `RAILWAY_RUN_UID=0`: Railway mounts volumes as root and our image runs as a normal user, so
  without it the quota file cannot be written. (If you skip the volume, also skip this and
  `ISSUER_QUOTA_FILE`; quotas then reset on each restart, which is fine for a demo.)
- `MAX_WAIT_MS=20000`: a private save waits at most 20 s for other users before writing (the
  default is 60 s). Good for a demo with few users; raise it for more privacy.
- Optional `COVER_MIN_BATCH=5`: a lone encrypted save is padded to a batch of 5 with cover records
  that nobody can tell from real ones. It costs gas for each cover record, and the demo's sketches are
  not encrypted, so it only helps apps that write with `encrypt: true`.
- `TOKENS_PER_DAY=20`: each wallet may write 20 private records a day (default 5).

6. **Deploy**. When it is up, open `https://<relay-1 domain>/healthz`. You should see
   `"ok":true`, the relayer's address and a `heartbeat` entity key. `https://<relay-1 domain>/v1/info`
   should show `"tokensRequired":true` and an `issuerUrl` equal to its own URL.

## 2. Railway: relay-2

In the same project: **New → GitHub Repo → same repo**. Rename it `relay-2`, generate a domain with
target port **8788**, no volume.

```env
ROLE=relayer
PORT=8788
RELAYER_NAME=relay-2
RELAYER_PRIVATE_KEY=<RELAYER_2_PRIVATE_KEY>
RELAYER_PUBLIC_URL=https://<relay-2 domain>
REQUIRE_TOKENS=on
ISSUER_WALLET_ADDRESS=<ISSUER_WALLET_ADDRESS>
ISSUER_URL=https://<relay-1 domain>
MAX_WAIT_MS=20000
ARKIV_ACCESS_KEY=<ARKIV_ACCESS_KEY>
```

`ISSUER_WALLET_ADDRESS` + `ISSUER_URL` make relay-2 accept the tokens relay-1 issues. Check
`https://<relay-2 domain>/healthz` after deploying.

Never give relay-2 the same private key as relay-1.

## 3. (Optional, later) Railway: ohttp-relay

Only when the app uses `ohttpRelay`. Ideally someone **other than** the relayer operators runs it.

```env
ROLE=ohttp-relay
PORT=8790
```

Domain with target port 8790. No keys, no volume. It forwards only to https relayers whose heartbeat
it can verify. Check `/healthz` shows `"targets": 2` after a minute.

## 4. Vercel: the demo site

1. [vercel.com](https://vercel.com) → **Add New → Project** → import `soumyacodes007/Arkognito`.
2. Leave **Root Directory** as the repository root (the demo builds the SDK from source). The
   repo's `vercel.json` sets everything else: install `npm ci`, build `npm run build -w arkognito-demo`,
   output `apps/demo/dist`.
3. **Environment variables: none.** Node version: 22, pinned by `engines.node: "22.x"` in the
   root `package.json`. A range such as `>=22` overrides Vercel's project setting and selects
   the newest available major version.
4. **Deploy**. Open the site:
   - `/observer.html` loads data straight from Arkiv (works even before the relayers are up).
   - `/sketch-private.html` → Connect MetaMask. MetaMask asks to add the Tiramisu network, then for
     three signatures (two for the key, one for tokens). Newly issued tokens must age for 60 s
     before use, so the first private save can take about 90 s. Once tokens are old enough,
     a save usually takes about 20–30 s and appears under "My sketches".

## 5. Check it end to end

- [ ] `https://<relay-1>/healthz` and `https://<relay-2>/healthz` return `"ok":true`.
- [ ] In a private window on another device: the demo site loads, the observer view shows data.
- [ ] Private sketch saves and appears in "My sketches" after a reload.
- [ ] The observer view's owner query on your MetaMask address shows only your **public** sketches.
- [ ] Railway logs show `batch N: … record(s)` lines and no `LOW BALANCE`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Railway 502 | `PORT` variable and the domain's target port differ. Make them the same. |
| `EACCES` on `/data` in relay-1's logs | Add `RAILWAY_RUN_UID=0`, or remove the volume and `ISSUER_QUOTA_FILE`. |
| "no relayer is reachable" on the site | Relayers not up yet, or `RELAYER_PUBLIC_URL` is not their https domain. Check `/healthz`; heartbeats appear on Arkiv within a minute of start. |
| "issuer refused: daily quota" | That MetaMask wallet used its tokens for today. Raise `TOKENS_PER_DAY` on relay-1. |
| `nonce too low`, `replacement transaction` or `stale key prediction` repeating in logs | The same wallet is also running somewhere else. Stop the other copy. |
| `LOW BALANCE` in logs | Fund that relayer's address (shown on `/healthz`) from the faucet or another wallet. |
| Saves take about 60 s | `MAX_WAIT_MS` not set; it defaults to 60000. |
| First private save takes about 90 s even with `MAX_WAIT_MS=20000` | New tokens have a 60 s minimum age before redemption, followed by the batch wait and transaction. Later saves use already-aged tokens. |

The full configuration reference and operations notes are in [self-hosting.md](self-hosting.md).
