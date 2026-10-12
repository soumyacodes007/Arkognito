# Self-hosting Arkognito

Arkognito is an SDK plus three small services. Nobody has to trust us: run the whole network
yourself, or run one piece and use other people's for the rest.

| Service | What it does | Sees | Needs |
| --- | --- | --- | --- |
| **Relayer** | Batches records from many users, writes them to Arkiv, hands each to its one-time owner, pays the gas | Records and one-time owners; IPs unless clients use an OHTTP relay | A funded Tiramisu wallet |
| **Token issuer** (optional, runs inside a relayer with `ISSUER=on`) | Hands out daily blind rate-limit tokens | Which wallet took how many tokens, never which records they paid for | Its own funded wallet and a 32-byte seed |
| **OHTTP relay** (optional) | Forwards encrypted requests so relayers never see client IPs | Client IPs, never request contents | Nothing on chain |

All shared state lives on Arkiv (heartbeats, issuer keys, the spent-token list), so there is no
database to run. Relayers find each other's tokens through Arkiv, and clients find relayers
through their heartbeat entities.

## 1. Quick start with Docker Compose

```bash
git clone https://github.com/soumyacodes007/Arkognito.git && cd Arkognito
npm ci
npm run setup                 # creates 3 wallets + the issuer seed in .env, prints addresses
# fund the printed addresses at https://hub.arkiv.network/faucet
OHTTP_ALLOW_LOCAL=on docker compose up -d
curl localhost:8787/healthz   # relay-1 (+ issuer)
curl localhost:8788/healthz   # relay-2
curl localhost:8790/healthz   # OHTTP relay
```

Point an app at it:

```ts
const ark = await createPrivateClient({
  app: "my-app",
  wallet,
  relayers: ["http://localhost:8787", "http://localhost:8788"],
  ohttpRelay: "http://localhost:8790", // optional: hide client IPs from the relayers
})
```

Or try it without writing code: `RELAYER_URL=http://localhost:8787 node examples/quickstart.mjs`
(that relayer requires tokens; for the quickstart run one with `REQUIRE_TOKENS=off`, see below).

`OHTTP_ALLOW_LOCAL=on` is only for this local setup: it lets the OHTTP relay forward to
`http://localhost` relayers. Never set it on a public relay.

## 2. Public deployment with HTTPS

Clients and the OHTTP relay only trust `https` relayers on public hosts.

1. Point DNS for your hostnames at the machine (for example `relay-1.example.com`,
   `relay-2.example.com`).
2. Edit `deploy/Caddyfile` with those hostnames.
3. In `.env` set
   ```
   RELAY_1_PUBLIC_URL=https://relay-1.example.com
   RELAY_2_PUBLIC_URL=https://relay-2.example.com
   ```
4. `docker compose -f docker-compose.yml -f deploy/docker-compose.tls.yml up -d`

Caddy obtains certificates automatically and the services stop exposing ports directly.

**Run the OHTTP relay somewhere else.** It only protects users if the relay and the relayers are
not run by the same people. Ask another team to host it (`ROLE=ohttp-relay`, nothing else to
configure), or host theirs for them.

## 3. Without Docker

Node 22+:

```bash
npm ci && npm run build
npm run setup
npm run relayer            # one relayer on :8787 (uses RELAYER_PRIVATE_KEY, else RELAYER_1_PRIVATE_KEY)
npm run ohttp-relay        # OHTTP relay on :8790
npm run dev:relayers       # or: two relayers + issuer on :8787/:8788, tokens on
```

A process manager (systemd, pm2) should restart them on failure; they keep no local state except
the optional issuer quota file.

## 4. Railway, Render, Fly and similar

Every service is the same image (`Dockerfile`); the `ROLE` variable picks what it runs.
`railway.json` sets the Dockerfile build, `/healthz` health check and restart-always.

Create one service per role from this repository and set:

| Service | Variables |
| --- | --- |
| relay-1 | `ROLE=relayer` `RELAYER_PRIVATE_KEY` `RELAYER_PUBLIC_URL=https://…` `ISSUER=on` `ISSUER_WALLET_PRIVATE_KEY` `ISSUER_RSA_SEED` `REQUIRE_TOKENS=on` `ISSUER_QUOTA_FILE=/data/issuer-quota.json` (mount a volume at `/data`) |
| relay-2 | `ROLE=relayer` `RELAYER_PRIVATE_KEY` (a different wallet) `RELAYER_PUBLIC_URL=https://…` `REQUIRE_TOKENS=on` `ISSUER_WALLET_ADDRESS` `ISSUER_URL=<relay-1 url>` |
| ohttp-relay | `ROLE=ohttp-relay` |

Optional on every service: `ARKIV_RPC_URL`, `ARKIV_ACCESS_KEY` (an Arkiv Hub key for higher rate limits).

## 5. Configuration reference

Relayer:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAYER_PRIVATE_KEY` | — | The relayer's wallet. One wallet per relayer, never shared. |
| `RELAYER_KEY_VAR` | `RELAYER_PRIVATE_KEY` | Read the key from a different variable (compose uses `RELAYER_1_PRIVATE_KEY`) |
| `RELAYER_PUBLIC_URL` | `http://localhost:$PORT` | URL announced in the heartbeat entity |
| `PORT` | 8787 | |
| `MIN_BATCH` / `MAX_WAIT_MS` / `MIN_INTERVAL_BLOCKS` / `MAX_BATCH` | 5 / 60000 / 5 / 40 | Batching: privacy against latency |
| `REQUIRE_TOKENS` | off | Require blind rate-limit tokens |
| `ISSUER` | off | Also run the issuer in this service |
| `ISSUER_WALLET_PRIVATE_KEY`, `ISSUER_RSA_SEED` | — | With `ISSUER=on` |
| `ISSUER_WALLET_ADDRESS`, `ISSUER_URL` | — | With tokens on, for relayers that do not run the issuer |
| `TOKENS_PER_DAY` | 5 | Per wallet (or per attestation code) per app per day |
| `ISSUER_QUOTA_FILE` | — | Keep quotas across restarts (names no wallet: entries are HMACs) |
| `ISSUER_CODES_FILE` | — | sha256 hashes of one-time attestation codes; when set, tokens need a code |
| `OHTTP` | on | Accept Oblivious HTTP requests |
| `RATE_LIMIT_PER_MIN` / `MAX_QUEUE` | 30 / 5000 | Per-address limit (tokens off only, kept in memory) / queue cap |
| `MAX_MIN_ANONYMITY` / `MAX_HOLD_MS` | 50 / 1800000 | Limits on what clients may ask for |
| `HEARTBEAT` / `HEARTBEAT_EVERY_MS` | on / 120000 | Discovery heartbeat |
| `LOW_BALANCE_GLM` | 0.2 | Log a warning below this balance |

OHTTP relay: `PORT` (8790), `OHTTP_TARGETS` (explicit allowlist; otherwise verified heartbeat
relayers), `OHTTP_ALLOW_LOCAL` (development only).

## 6. Operating it

- **Gas.** Every batch and every heartbeat costs gas. Across all our test runs (several hundred
  records plus heartbeats) one relayer spent about 0.1 GLM. Watch `balanceGlm` on `/healthz`; the relayer logs
  `LOW BALANCE` below `LOW_BALANCE_GLM`. The faucet gives 0.1 GLM a day per wallet.
- **Health.** `/healthz` reports queue length, batches written, the last flush block, the heartbeat
  entity, balance and any double-spent tokens detected.
- **Restarts.** Safe at any time. Queued requests are lost and clients retry elsewhere; a request
  that was already written is recognised by the client, so nothing is written twice. The heartbeat
  and the OHTTP gateway key survive (the key derives from the relayer's wallet key).
- **Issuer key rotation.** Automatic: one RSA key per app per UTC day, derived from
  `ISSUER_RSA_SEED`. Never change the seed during a day (clients would see two keys and refuse
  the issuer).
- **Logs.** The services log batch summaries only, never IPs or request bodies. Keep it that way in
  your proxy too (the sample Caddyfile discards the OHTTP relay's access log).
- **Wallets.** One wallet per relayer and one for the issuer. Never run two processes on the same
  wallet: their transactions would collide.

## 7. Running only part of it

- **Only a relayer** (no tokens): `npm run relayer` with `REQUIRE_TOKENS=off`. A per-address rate
  limit protects your gas.
- **A relayer that accepts another team's tokens:** `REQUIRE_TOKENS=on`, `ISSUER_WALLET_ADDRESS`
  and `ISSUER_URL` of their issuer.
- **Only an OHTTP relay** for someone else's relayers: `ROLE=ohttp-relay`. It forwards only to
  relayers with a verified live heartbeat.
