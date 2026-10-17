# Changelog

## 0.1.0 — 17 October 2026

Initial experimental Tiramisu release of Veil under the npm package name `arkognito`.

- Recoverable one-time record owners, encrypted payloads, recipient inboxes and ownership challenges.
- Shared relayers, atomic create/ownership transfer, batch privacy controls and optional OHTTP.
- Blind-token issuance and redemption with per-identity quotas.
- Optional `arkognito/semaphore`: group administration, vault-derived membership identities,
  browser-worker proving, proof-gated submissions and independent historical verification.
- Durable single-host admission reservations and retained earliest-valid nullifier state after
  record deletion or expiry.
- Public protocol/schema, integration guides and recorded test evidence.

Experimental limits include public metadata, manual uncertain-write reconciliation, historical RPC
dependencies, no cross-host coordination, no production credential adapters and no independent
audit. The pinned blind-RSA dependency declares Node >=24 while the repository targets Node 22;
Node 22 installs warn, and engine-strict installs reject that mismatch. See the README and
[release checks](docs/release-0.1.0.md).
