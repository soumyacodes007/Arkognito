# Security

Arkognito is experimental and testnet-only. Its cryptography has not had an outside audit.

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/soumyacodes007/Arkognito/security/advisories/new)
rather than a public issue. Include steps to reproduce and the commit you tested.

What we consider in scope: anything that lets someone link records to each other or to a wallet,
read an encrypted payload, forge a record or an ownership proof, spend a token twice, make a relayer
write something its owner did not sign, or make the OHTTP relay forward somewhere it should not.
The known, documented limits are in [docs/edge-cases.md](docs/edge-cases.md).
