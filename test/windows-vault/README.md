# Windows vault qualification

The `vault` job in `windows-migration.yml` runs on `windows-latest` and
`windows-2022`, including pushes to `verify/**`. It builds core and OpenCode,
then bundles a private test entry exposing the production plugin composition
seam and custody manager. The request still goes through the full plugin auth
loader and shared request executor. Only the final transport destination is
redirected to an independent loopback HTTP recorder.

The daemon is the existing `startMenuVaultFixture`, extended with the scoped-get
response already used by the native V1 activation harness. It uses the installed
SubC framing and handshake implementation. Its operator `approve()` toggles a
synthetic approval; it does not simulate the operator CLI, grants administration,
or a real credential refresh. It accepts the enrollment request secret without
verifying its hash. No enrollment callbacks or token writers are injected into
the product: proposal, polling, token persistence, scoped list and scoped get
all use the real clients. Neither manifest locks nor locked handle-file writes
are used.

The profile is created strictly below the runner's original `%USERPROFILE%`.
`RUNNER_TEMP` holds only the redacted receipt, never enrollment state. PowerShell
`Get-Acl` reads the persisted token's actual security descriptor. The assertion
requires the canonical newly-created private-files template: a protected DACL,
one explicit user ACE with `FILE_ALL_ACCESS`, and a user/SYSTEM/Administrators
owner. SYSTEM and Administrators are allowed owners, **not** additional grants
on a private token. The inherited-file exception supported for existing files
is not needed for a freshly enrolled token.

A local account file contains an unused synthetic refresh token and a project
different from the vault's project. Its presence detects accidental fallback to
local credentials instead of letting an empty profile hide local reads.
A read fence records/refuses local account and
store reads through both Node filesystem APIs and the actual Windows private-files
N-API read boundary. The native module cache facade forwards every other native
operation unchanged. Positive controls prove both read boundaries are observable
before loading the built product; the final assertion checks that no attempted
local reads were swallowed by the product. The host-login callback passed to
the plugin auth loader counts and throws on any call. After
disposal, the dormant file must be unchanged.

Only `receipt.json` is uploaded. It contains completed stage names, redacted DACL
identities, daemon method names, bearer/project match booleans, control results,
and read counts. It never contains token files, connection keys, raw request
bodies, exception messages, or profile contents. The workflow deletes the
synthetic profile after uploading the receipt, including on failure.

Local checks:

```sh
node --check test/windows-vault/product-entry.mjs
node --check test/windows-vault/verify.mjs
node --check test/windows-vault/dacl.mjs
node --check test/windows-vault/local-reads.mjs
node --check test/windows-vault/guards.test.mjs
node --test test/windows-vault/guards.test.mjs
```

`verify.mjs ROOT EVIDENCE --portable-smoke` can test the real enrollment wire
and executor wiring on POSIX after the same product build and test-entry bundle.
`ROOT` must be a fresh directory below the real home directory. Run with
`node --experimental-import-meta-resolve` so the daemon resolves SubC from the
installed Claustrum client's own dependency tree. The portable receipt explicitly
skips DACL qualification and is **not** Windows proof. Only successful runs of
both real Windows jobs qualify the Windows path.
