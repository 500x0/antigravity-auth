# Owned-command orphan diagnosis

Base: `86c4acd4fb590fa48596dabe06c7179dfd004201`.
Execution environment: Linux via `runon`, Bun **1.4.2** (`744846f84`), Node
**v24.21.0**, TypeScript **6.0.3**, Biome **2.5.3**. Observations below are
excerpts and extracted process identities, not complete command transcripts.

## Diagnosis before the fix

The first Linux `bun run test` reproduced the PID 1 refusal. Failure-only
`/proc` diagnostics identified the unmatched candidate as:

```json
{"pid":93,"ppid":1,"pgid":70,"sid":70,"start":"88840441","zombie":false}
```

Its command line was `/home/ubuntu/.bun/bin/bun -e setTimeout(() => {}, 750)`.
The captured leader was PID **70**, SID/PGID **70**, birth **88840373**.
The candidate was born **68 kernel clock ticks after the leader**, remained
sleeping, and had already been reparented to PID 1. The `/proc/93/status`
snapshot included:

```text
Name:   bun
State:  S (sleeping)
Pid:    93
PPid:   1
NSpgid: 70
NSsid:  70
```

The failure reported `ownedCommandCleanup:false` and `signals:[]`: the wrapper
refused to adopt or signal the unverified orphan.

A second reproduction used the wrapper around these files:

```sh
bun scripts/prepare-common-auth-public-consumer.ts bun test --isolate \
  test/build-phase-clock.test.ts test/windows-ci.test.ts \
  packages/opencode/scripts/smoke-tui-pack-install.test.ts \
  test/common-auth-010-store/public-consumer.test.ts
```

An independent Python `/proc` sampler matched the exact three-argument command
line, reading its stat and its parent's stat/command line before termination.
It observed both parent states for the **same PID and birth identity**:

| Process | PID | PPID | PGID | SID | Birth ticks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Captured test leader | 13 | 5 | 13 | 13 | 88856616 |
| Synchronous waiter before termination | 22 | 13 | 13 | 13 | 88856663 |
| Compiler fixture before reparenting | 27 | **22** | 13 | 13 | **88856664** |
| Compiler fixture after reparenting | 27 | **1** | 13 | 13 | **88856664** |

The sampler's original-parent stat began:

```text
22 (bun) S 13 13 13 0 -1 4194304 1594 0 1 0 0 0 0 0 20 0 5 0 88856663
```

The original parent's command was `bun -e` with the following identifying
source (the absolute import and temporary-root paths are omitted here):

```js
import { spawnSync } from 'node:child_process';
import { withBuildPhaseClock, buildSyncPhase } from '.../scripts/build-phase-clock.ts';
await withBuildPhaseClock('blocked build', 50, async () => {
  buildSyncPhase('child spawn compiler', () => {
    console.log('blocking-ready');
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 750)'], { timeout: 2000 });
  });
}, { root: '.../build-phase-clock-1iauHt' });
```

This identifies **`phase clock reports a synchronous child wait from an
independent wrapper` in `test/build-phase-clock.test.ts`**, not either of the
initially suspected Windows or historical-build tests. Its `finally` killed
only the synchronous waiter and awaited that waiter's close. The live compiler
fixture survived for its 750 ms timer and lost its verifiable parent before the
wrapper's first capture. The 50 ms phase-clock deadline only controls reporting;
it does not terminate or reap processes.

The CI log contains no candidate command line, so the historical CI PID cannot
be independently identified retroactively. The unchanged test's actual Linux
reproductions establish a concrete source of the reported ancestry failure.

## Changes and preserved contract

- Keep the phase reporter assertions, but let the bounded synchronous spawn
  finish and reap its compiler before awaiting the waiter's clean exit. Assert
  `[0, null]` from the waiter's close event instead of accepting a killed waiter.
  The compiler also must exit successfully.
- Move `blocking-ready` into the compiler with inherited output, so readiness
  means the waiter really is in its synchronous wait, rather than merely about
  to spawn. The independent reporter still observes `child spawn compiler` and
  no `child exit` before cleanup.
- When the ancestry walk refuses at PID 1 on Linux, append the original
  candidate, leader, traversed chain, and bounded `/proc/<candidate>/cmdline`
  and `status` snapshots to the error. Read/close failures are diagnostic data;
  snapshots are never used to admit or signal a process.
- Add a Linux diagnostic regression using synthetic ancestry and the test
  runner's real `/proc` files. It asserts that neither the orphan nor PID 1 is
  admitted and no signal is recorded. Existing ancestry, birth, SID/PGID,
  reparented-captured-descendant, and individual-signal tests remain unchanged.

No ownership predicate, discovery boundary, or signaling path was weakened.
No test-child process-group signaling or SID-only adoption was added. An
inspector correction and a new real-orphan inspector test were unnecessary:
the inspector correctly refused the test's unaccounted process.

## Verification

All executable checks ran on Linux; no package manifests or lockfiles changed.

- `bun run build`: passed; copied 133 core embedded files, checked 85 strict
  embedded declaration roots in NodeNext/Bundler, finalized 214 OpenCode and
  169 Pi declaration files, built 2 audited product bundles and both TUI targets
  (26 and 12 runtime files).
- `bun run typecheck`: passed after the final TypeScript edit. This is the root
  script covering package checks and `tsc -p tsconfig.scripts.json`, not Bun's
  transpilation-only test runner (TypeScript 6.0.3).
- Direct `bun test --isolate test/build-phase-clock.test.ts
  packages/core/src/public-command-scope.test.ts`: **16 pass, 0 fail, 56 expects**
  after both mutants were restored.
- Wrapper around the same two files: **5 consecutive passes**, each **16 pass,
  0 fail**, with `ownedCommandCleanup:true`, no signals, no primary failure,
  and no cleanup failure. These runs preceded the final argv0 assertion
  refinement described below.
- The broad prefix below: **3 consecutive passes**, each **62 pass, 0 fail,
  154 expects** across 5 files (11.53 s, 11.49 s, 11.72 s). All three included
  successful Windows bundles, historical baseline build, and packed public
  consumer tests. Every wrapper result had `ownedCommandCleanup:true`,
  `signals:[]`, `primary:null`, and `cleanupFailure:null`.

```sh
bun scripts/prepare-common-auth-public-consumer.ts bun test --isolate \
  test/build-phase-clock.test.ts packages/core/src/public-command-scope.test.ts \
  test/windows-ci.test.ts packages/opencode/scripts/smoke-tui-pack-install.test.ts \
  test/common-auth-010-store/public-consumer.test.ts
```

The three broad prefix runs followed `bun run build` in the same remote job
(remote jobs do not preserve these local build outputs). A job-private `git`
shim in `$TMPDIR`, put on `PATH`, executed the real Git with
`-c safe.directory=<this worktree>` to accommodate the runner's read-only Git
mount ownership. The wrapper deliberately constructs an allowlisted environment
(`scripts/prepare-common-auth-public-consumer.ts:150-174`), so an earlier exported
`GIT_CONFIG_GLOBAL` alone did not reach its child. No repository or global Git
configuration was changed.

- `bun run lint`: **462 files checked**, no fixes or errors (Biome 2.5.3).
- `bun run format:check`: **462 files checked**, no fixes or errors.
- Sidekick comment review: all 3 source files reviewed; 2 added comment blocks,
  none flagged as unclear.
- Scoped `inspect`: Biome reported zero diagnostics; TypeScript LSP analysis
  was unavailable because its mise-config initialization crashed. The root
  TypeScript gate above passed independently.

### Wider-gate environment limitations

An intermediate root run after the cleanup fix reached **3354 pass, 4 fail**
across 176 files, with `ownedCommandCleanup:true` and no cleanup failure. Its
four failures were unrelated runner prerequisites:

1. Historical baseline build: Git rejected the mounted worktree's ownership.
   This subsequently passed in all three broad prefix runs using the private
   shim above.
2. `embed.clean_input`: `docker` executable not available.
3. `build.repo_hygiene`: frozen offline install could not find private-toolchain
   dependencies in `/home/ubuntu/.bun/install/cache`.
4. `build.private_toolchain`: the same unavailable offline cache; errors included
   `@opentui/core`, `@opentui/solid`, and `typescript` not in the cache.

An earlier focused attempt also lacked built core/Pi outputs and therefore
failed bundle/packed-consumer checks; building first resolved those failures.
No out-of-scope fixes were made for these runner conditions.

### Non-vacuity controls

For each final control, the live implementation was first staged and
`git diff --stat` confirmed empty. Each temporary edit included the token
`NON-VACUITY BREAK`; restoration used `git checkout -- <path> && touch <path>`
and again produced an empty unstaged diff.

1. Restore premature `child.kill('SIGTERM')` before awaiting the waiter:
   `test/build-phase-clock.test.ts | 1 +` while applied, empty after restore.
   **Only** `phase clock reports a synchronous child wait from an independent
   wrapper` failed: expected `[0, null]`, received `[null, "SIGTERM"]`.
   **15 sibling tests passed**, including the diagnostic and all ancestry tests.
2. Rethrow before appending unmatched-candidate diagnostics:
   `packages/core/src/__fixtures__/public-command-processes.test.ts | 1 +`
   while applied, empty after restore. **Only** `includes unmatched candidate
   proc diagnostics when refusing ancestry through init` failed because the
   diagnostic JSON was absent. **15 sibling tests passed**, including the waiter
   and all existing ancestry tests.

The first waiter-mutant attempt also exposed an overly strict diagnostic test
assumption: direct `bun test` has raw argv0 `bun`, whereas the wrapper launches
with its absolute executable path. The assertion now uses `process.argv0` and
also requires `test` in the command line. Repeating the mutant then produced
exactly the single intended failure above. No mutant remains in the tree.

Passing-test inventory for the two final controls:

- `phase clock reports a synchronous child wait from an independent wrapper`
  passed with diagnostics omitted, and failed only with premature waiter kill.
- `includes unmatched candidate proc diagnostics when refusing ancestry through init`
  passed with premature waiter kill, and failed only with diagnostics omitted.

Every test below passed under **both** controls:

- `phase clock reports the exact overdue await once and stays silent before its deadline`
- `phase clock never reports successful tests, even when their command later fails`
- `phase clock preserves the innermost failed await and the original rejection`
- `phase clock reports a killed command before the test deadline without inventing an exit`
- `phase clock diagnostics do not mask a build error when the journal cannot be written`
- `copied build scripts join the installed phase clock without importing its helper`
- `admits a separately grouped child only through fresh parent/birth ancestry`
- `refuses an unseen same-session orphan rather than retrospectively adopting it`
- `refuses a parent born after the candidate child`
- `refuses a reused captured ancestor before admitting its candidate child`
- `retains captured descendants after parent and leader exit`
- `rechecks ancestry birth identities before recording a new descendant`
- `refuses changed recorded PGID or SID before dispatching a signal`
- `requires capture before signaling and treats an owned ESRCH as benign`
