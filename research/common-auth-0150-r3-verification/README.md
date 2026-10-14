# common-auth 0.15.0 safe-parent candidate verification

## Current fourth candidate

The reviewer supplied a replacement built from [common-auth commit `4532c485`](https://github.com/cortexkit/common-auth/commit/4532c485). Both archive hashes were remeasured before use.

- Archive bytes: 259,051
- Archive SHA-256: `dd43bb66bf9f68ea7a489f27878576607fa3b07d5c39967b275f9b482d69625d`
- Uncompressed tar SHA-256: `a99a749251dc1f976ad38e2b0464e8589b81db494bbc4f839fa7a6d88ef2c3a4`
- SRI: `sha512-SheMZ22vSkP4KM62yvyhEwLc285rOitONDElFXYuwQjhi6dLA2xWSxwLzN0d3tq7L/GGqCLmIwZI9GVz+DSN2Q==`
- OpenCode embedded publication files: 158 files, 854,261 bytes
- Core embedded publication files: 131 files, 726,163 bytes
- Full admitted publication: 191 members, 965,823 payload bytes
- Private compiler lock SHA-256: `98de92764326deb0013afbdceac411cd5e0d0b45d4f538ca65afd284eade4f44`
- Runtime private-files remains exactly `0.2.1`; no unrelated compiler dependency changed.

The compiler archive was re-resolved offline with lifecycle scripts disabled, using a temporary local archive path to invalidate Bun's old same-path integrity record, then restoring the canonical input path. Both embedded trees and provenance were regenerated only by `bun packages/opencode/scripts/embed-common-auth.ts` and `bun packages/core/scripts/embed-common-auth.ts`.

The fourth candidate removes the static logger import. The unchanged `graph.renderer_private_files_external_dynamic_import` and `graph.server_cli` tests, which require the backend to remain external and dynamically imported in built output, now pass on Linux, along with six other graph tests: eight passes, zero failures, 141 assertions. The exact producer closure suite also passes: eight tests, 1,329 assertions. Typecheck passes with TypeScript 6.0.3. No renderer, generator transformation, or graph assertion was weakened. The third-candidate defect and its original evidence below are historical, not a finding against the current archive.

## Our fixture repair

The separate fixture commit stages the installed `@cortexkit/private-files` runtime package, which checks that other ordinary users cannot modify containing directories, in both the top-level admitted public consumer and each nested migration consumer, on all platforms. Publication bytes and prior assertions are untouched. All 11 consumer-admission tests pass (35 assertions), including Node resolution of the real linked backend and rejection of an incorrect link.

Non-vacuity control: after staging the live fixture changes in the index and confirming an empty working-tree diff, `stagePrivateFilesDependency` was temporarily replaced with a no-op marked `NON-VACUITY BREAK`. The working diff showed one file, three insertions and 16 deletions. Only `stages the real private-files backend for isolated public consumers on every platform` failed (`ERR_MODULE_NOT_FOUND: Cannot find package '@cortexkit/private-files'`); `admits the complete genuine publication and records every member payload` passed. Two tests ran, one pass and one failure. Restoring the file from the index and touching it returned the working-tree diff to empty; the restored 11-test suite passed.

## Final fourth-candidate Linux verification

All requested commands were run on the Linux runner, with core built first. Tools were Bun 1.4.2, Node v24.21.0, TypeScript 6.0.3, Biome 2.5.3 and ckdev-mutate 0.12.0. Fresh locked root/compiler installs with scripts disabled prevented stale runner installations from being mistaken for the current archive. The source and lock updates themselves were made offline in this worktree; network was needed for runner dependency preparation and pack/install smoke consumers.

| Gate | Result |
| --- | --- |
| `bun run --cwd packages/core build` | Passed; 131 embedded files copied |
| `bun run typecheck` | Passed; workspace/script checks plus 78 embedded strict declaration roots |
| `bun run build` | Passed; core, OpenCode and Pi; both raw/runtime TUI roots |
| `bun run test` | **Failed**: 3,097 passed, 273 failed; 3,370 tests across 173 files, 15,549 assertions |
| `bun run test:e2e` | Passed: 79 tests, 529 assertions |
| `bun run --cwd packages/opencode smoke:tui` with network | Passed: four fresh packs, eight product and four baseline consumers; Linux packed backend resolution checks included |
| `bun run format:check` | Passed: 452 files |
| `bun run lint` | Passed: 452 files |
| `ckdev-mutate check` | Passed: catalogue anchors and exact test names verified |
| `ckdev-mutate run --all` | **Failed**: 22 controls caught; the cursor control could not reach mutation because its unmutated baseline failed |
| `node --check test/windows-migration/verify.mjs` | Passed: one script parsed |
| `node --check test/windows-migration/sync-hook.mjs` | Passed: one script parsed |
| Workflow YAML | Parsed with locked YAML 2.9.0; layout checks passed |

The full unit failures are grouped conservatively; passing build/pack gates do not turn this into a green unit suite:

- **262 failures explicitly report the runner's unsafe `node_modules` ancestry.** They now resolve private-files, then refuse `safe-parent` with `reason: "wrong-owner"`, `code: "ERR_PRIVATE_FILES_SECURITY"`. The job runs as uid 999/gid 986; the runner mounts `node_modules` and `packages/core/node_modules` as uid/gid 1000 with mode 0775. This is a real policy refusal, not a missing fixture dependency. Ownership/permissions were not changed to bypass it.
- **Two Docker-dependent failures:** `embed.clean_input` and `build.repo_hygiene`; Docker is absent on the runner.
- **One offline-cache failure:** `build.private_toolchain`; the owned unit-test command resets HOME and drops caller cache overrides, leaving that fixture's required offline cache empty.
- **One RPC child timeout:** `S-RPC complete contracts on the current unit-test runtime`, `spawnSync .../bun ETIMEDOUT` at the existing 45-second limit. The fourth candidate no longer has the third candidate's static-import loader failure. The timeout's deeper cause is not established by this run.
- **Seven indirect assertion failures, not conclusively attributed:** concurrent fresh migration had zero completed results; unfinished-generation binding returned `initialization-required` rather than `pending`; the real Pi registry returned no native credential; four Pi selected-credential boundary tests observed zero admissions rather than one. Their names and expected values were preserved. An owner-matched runner rerun is needed before assigning these indirect effects to candidate behavior.

All eight graph tests passed in the full run, including the unchanged renderer/server dynamic-import requirements. No gate was skipped or assertion relaxed. The 273 remaining unit failures and the mutation baseline error are limitations of this delivery's verification, not claimed successes.

### Unmutated independent-cursor baseline trace

The exact command from the unchanged mutation row was rerun without applying any mutation:

```sh
bun scripts/prepare-common-auth-public-consumer.ts bun test --isolate test/common-auth-010-store/migration-crash.test.ts -t '^genuine\spublic-store\soffline\smigration\simports\sfull\srows,\scredential\sstamps,\sfield\spresence,\sorder\sand\sindependent\scursors\sthen\sverifies\sactive\sno-op$'
```

It still fails with the fourth candidate **before the cursor assertion**:

```text
PrivateFileError: Private file refused at safe-parent: <worktree>/node_modules (wrong-owner).
reason: "wrong-owner"
code: "ERR_PRIVATE_FILES_SECURITY"
public-consumer/node_modules/@cortexkit/common-auth/dist/fs/private-files.js:78:19
  -> verifySafeDirectory -> ensurePrivateDirectory
  -> refresh-file-lock.js:179:15 (tryAcquire)
  -> refresh-file-lock.js:536:26 (acquireRefreshFileLock)
  -> with-lock.js:24:28
  -> packages/core/src/account-migration.ts:2558:20
  -> test/common-auth-010-store/migration-crash.test.ts:736:65
(fail) genuine public-store offline migration > imports full rows, credential stamps, field presence, order and independent cursors then verifies active no-op
0 pass, 94 filtered out, 1 fail; Ran 1 test across 1 file.
```

The initial third-candidate failure was missing dependency staging. After our fixture repair, both the third and fourth candidates reach the real backend and encounter the runner ownership refusal. The mutation baseline is therefore blocked by runner ancestry, not an observed independent-cursor regression. Neither the test nor its mutation catalogue row was changed.

## Windows layout and pending CI

Both `windows-latest` and `windows-2022` run the same two scenarios. The positive profile is in a dedicated `agy-migration-evidence-safe/profile` beneath the real `%USERPROFILE%`. The negative profile is in `agy-migration-evidence-unsafe/profile` beneath `RUNNER_TEMP`. Each scenario must first reproduce the released 3.0.0 CLI's EPERM/fsync leftover, with original pool and abandoned backup bytes intact.

The positive case retains active-generation receipt checks, full account-field equivalence, backup preservation and same-pointer replay. The negative case requires exit 1, the exact `safe-parent` / `writable-by-others` refusal and complete advisory text from the candidate's CLI error handler, unchanged legacy bytes, no pointer, and an identical before/after inventory of every profile file's hash. That text is pinned from the candidate implementation; Windows execution has not yet confirmed it. Separate safe/unsafe artifacts prevent same-named evidence files from colliding, and both synthetic profiles are cleaned after upload even when a case fails. The ACL diagnostic step was removed; the `verify/**` push trigger remains.

Windows CI is pending the parent's push. No Windows migration, refusal, ACL or replay pass is claimed.

## Historical third-candidate identity

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

## Historical third-candidate finding: a static private-files edge reaches the OpenCode 1 renderer

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

## Historical third-candidate Linux gates and runner limitations

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
