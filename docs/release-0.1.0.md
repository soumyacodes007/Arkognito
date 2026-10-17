# arkognito 0.1.0 release checks

17 October 2026. Release preparation for the first experimental npm package. No new chain writes
were made for these checks; the earlier 32-check live/browser evidence remains in
[semaphore-validation.md](semaphore-validation.md).

## Executed checks

| Check | Observed result |
| --- | --- |
| Node runtime for repository checks | 22.23.3 |
| SDK build | Passed |
| Monorepo typecheck | Passed |
| Offline tests | 46 passed, 0 failed |
| Existing demo production build | Passed |
| Mintlify build validation | Passed, including the final engine-warning documentation |
| Mintlify broken links | No broken links, including the final documentation changes |
| Separate consumer install | Installed the packed tarball and pinned peers in a fresh temporary directory; 201 packages added |
| Compiled package smoke test, Node 22.23.3 | Root/module exports, recovered commitment, actual proof verification, content/owner tamper rejection and compiled worker URL passed |
| Compiled package smoke test, Node 24.13.1 | The same checks passed |
| Installed TypeScript declarations | A separate consumer checked under strict NodeNext resolution |
| Tarball inspection | Includes compiled SDK, worker, declarations, sources, README, Semaphore guide and MIT license |
| Configured-secret scan | 245 public files and final tarball checked against 11 configured secret values; no matches |

The smoke test exercises installed package code without source conditions. Its proof uses synthetic
random-secret identities and an offline group; it is not a new live Arkiv integration run.

The final tarball is **134,717 bytes**, with **119 entries**. SHA-256:
`e0d3e378b2dcdeb45b555965e42cf773e84eee62c22ad5aab30947b7911a9c9c`.
All 118 non-README entries match the installed artifact tested above; the final README adds the
observed engine-compatibility warning. No runtime code changed after consumer verification.

## Actual warnings and blockers

- Node 22 clean installation emitted `EBADENGINE` for `@cloudflare/blindrsa-ts@0.4.6`, which declares
  Node `>=24`. The test suite passed on Node 22.23.3, but strict engine enforcement would reject
  installation. Dependencies were not silently downgraded or upgraded.
- Offline tests again emitted `MaxListenersExceededWarning`, this time about 14 socket `unpipe`
  listeners. The source remains undiagnosed; proving workers still need the explicit test shutdown.
- The demo build repeated its `__dirname` and browser-externalized `crypto` warnings and completed.
- Initial `npm whoami --registry=https://registry.npmjs.org` failed with
  `E401 Unauthorized - GET https://registry.npmjs.org/-/whoami`. Authentication is required to publish.
- The public registry lookup returned `E404` for `arkognito`; package publication was not assumed.
- The actual publish attempt of the tested tarball was rejected with
  `E404 Not Found - PUT https://registry.npmjs.org/arkognito - Not found` and
  `The requested resource 'arkognito@0.1.0' could not be found or you do not have permission to access it.`
  The account check also failed with `E401`; a valid npm login is needed before retrying. No npm
  publication or version tag is claimed by this record.

Code and documentation were fast-forwarded to their GitHub `main` branches after validation. This
release remains prepared locally pending successful npm publication. Run `npm login` locally;
never put registry credentials, OTPs or tokens in the repository or chat.

These checks do not establish an independent audit, production credential admission, mobile or
physical-authenticator support, or safe dependency exploitability. See the README for scope.
