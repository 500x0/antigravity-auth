# common-auth 0.15.0 safe-parent candidate verification

## Candidate identity

The input is the candidate built from [common-auth commit `dbd4a3ff`](https://github.com/cortexkit/common-auth/commit/dbd4a3ff), not a published-release claim.

- Archive: `tools/common-auth-build/inputs/cortexkit-common-auth-0.15.0.tgz`
- Archive bytes: 258,873
- SHA-256: `a3305f894bae4fd2ced7aca744be18ceb8d58b5676d9b02f39c4f17ca01bc10c`
- Uncompressed tar SHA-256: `caf60b3f91f86e91f62cd39af25dc6304ba191a1890c181ae36cebe530c554f1`
- SRI: `sha512-fP/xsHnuJLPIPBOxMGnF5zXRC3vHZdSWSaF9P+OAvfJGv1AzIet11vz/haqNMjJ4Vr3yh72DggRXmFTOwGMHbg==`
- OpenCode canonical closure: 158 files, 853,846 bytes
- Core canonical closure: 131 files, 725,748 bytes
- Private compiler lock SHA-256: `40b9a131320fd7d7f6e02631008957f99bd16b2a42c9cf1f2e889482224e3a44`
- Runtime private-files pin: `0.2.1` in core and OpenCode, within the candidate's `^0.2.1` range

Both embedded trees and their provenance were regenerated through their owning embedding scripts. The private compiler lock was refreshed offline with lifecycle scripts disabled; unrelated compiler transitive resolutions were retained. `test/common-auth-0113-producer/closure.json` records the exact imports reachable from the published entry points. It now includes the candidate's new declaration edge from `fs/with-lock.d.ts` and its static logger dependency. The separate `graph.renderer_private_files_external_dynamic_import` and `graph.server_cli` tests still require backend imports to be external dynamic calls; their assertions were not changed.

## Candidate finding: a static private-files edge reaches the OpenCode 1 renderer

The candidate publishes this runtime import at `package/dist/logger/engine.js:4`, preserved at `packages/{core,opencode}/src/common-auth-embedded/logger/engine.js:4`:

```js
import { verifySafeParentSync } from '@cortexkit/private-files';
```

A Linux build followed by `auditGraph` on each emitted renderer entry establishes that both OpenCode 1 renderer entries reach the static `@cortexkit/private-files` import shown above:

- `packages/opencode/src/tui-raw/tui.tsx` reaches `src/tui-raw/common-auth-embedded/logger/engine.js:4`.
- `packages/opencode/src/tui-compiled/tui.js` reaches `src/tui-compiled/common-auth-embedded/logger/engine.js:4`.
- The OpenCode 2 GA raw/compiled entries do **not** reach this logger. Their independent graph proofs pass.

The built `dist/index.js`, `dist/cli.js`, and `dist/server.js` metafiles each include both `../core/dist/common-auth-embedded/logger/engine.js` and `src/common-auth-embedded/logger/engine.js`. Each output has two `@cortexkit/private-files` edges with `kind: "import-statement", external: true`, in addition to three external dynamic-import edges. Externalization prevents bundling the backend bytes, but does not make the static imports lazy or Windows-only.

The renderer declaration closure also contains the candidate's new erased `import type` in `fs/private-files.d.ts:2`. `graph.renderer_private_files_external_dynamic_import` scans every emitted file and requires every occurrence of the `@cortexkit/private-files` specifier to belong to a dynamic import call. It remains unchanged, rather than relaxing its assertion for this candidate.

Exact red output from the unchanged graph tests (Bun 1.4.2, Linux):

```text
254 |           expect(ts.isCallExpression(node.parent)).toBe(true)
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) graph.renderer_private_files_external_dynamic_import [24.06ms]

300 |         (edge) => edge.external && edge.kind === 'dynamic-import',
302 |     ).toBe(true)
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) graph.server_cli [169.34ms]

6 pass
15 filtered out
2 fail
125 expect() calls
Ran 8 tests across 1 file. [3.95s]
```

`graph.source`, `graph.raw`, `graph.runtime`, `graph.tui_client_narrow`, `graph.ga_roots`, and `graph.ga_policy_refusals` passed in that run. The owner must fix the published candidate to restore dynamic-only renderer use. The task reviewer explicitly authorized delivering the candidate and Windows layout while preserving these failing proofs; no renderer or generator transformation was authorized or applied.

## Linux gates and runner limitations

Tools: Bun 1.4.2, Node v24.21.0, TypeScript 6.0.3, ckdev-mutate 0.12.0.

- Core build first: passed; copied 131 embedded files.
- `bun run typecheck`: passed; includes 78 embedded strict declaration roots under NodeNext/Bundler.
- `bun run build`: passed; two TUI roots and all workspace build targets.
- `bun run test:e2e`: passed, 79 tests, 529 assertions.
- `bun run --cwd packages/opencode smoke:tui` with network: passed; four fresh packs, eight candidate and four baseline consumers. Every Linux candidate consumer resolves and exercises private-files from both packed server packages, with four checks per consumer.
- `bun run format:check` and `bun run lint`: passed, 452 files each.
- Producer closure suite after refreshing exact imports: passed, eight tests, 1,329 assertions.
- `ckdev-mutate check`: passed.

The first full unit run had 3,092 passes and 276 failures across 3,368 tests. Isolated public-consumer fixtures did not stage private-files, producing `ERR_MODULE_NOT_FOUND` now that server-side safe-parent checks load it on POSIX. Fixture repairs and the subsequent full-suite/mutation results are recorded separately below; the upstream renderer finding is not a fixture problem.

The Linux runner has no Docker executable, so the unchanged Docker-based `embed.clean_input` and `build.repo_hygiene` gates cannot pass there. Its default Bun compiler cache is also empty, and its preinstalled private compiler copy initially contained the previous candidate. A frozen, scripts-disabled install of the current compiler inputs with network was needed before Linux build gates. The checked-in compiler lock itself was refreshed offline locally. The root test wrapper deliberately replaces HOME and strips cache overrides; this explains the initial `build.private_toolchain` offline-cache failure and is not evidence of bad candidate bytes.

Windows execution remains pending GitHub CI after the parent pushes; no Windows pass is claimed.
