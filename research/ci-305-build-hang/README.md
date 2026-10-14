# Linux CI build-hang investigation

## Delivery: diagnostics, not a root-cause fix

The release owner approved failure-only phase clocks as a standalone change.
The exact full unit command did **not** hang in the available Linux environment.
An order-preserving nine-file prefix reproduced the earlier CI failure signature,
but neither an introducing merge nor the precise runtime defect is proven.
No timeout, deadline, retry, test selection, or existing assertion was changed.

The clocks cover `build.product_two_roots`, the build fixture's `beforeAll`,
and the historical-baseline unit test. They record fixture awaits, path admission,
prerequisite checks, graph reads/traversals, compiler spawn/return, selector checks,
inventory, hashes, and cleanup. Spawn returns include PID, status, signal, and error.
The compiler itself is not modified.

Journals live inside the existing owned public-consumer fixture, not in source or
operator directories. The outer wrapper checks them once a second and prints
`[build-test-phase-clock]` JSON only for failed tests, running tests whose existing
test deadline has elapsed, or an incomplete test when its command fails/is killed.
This reporter runs outside the Bun test process, so a stuck synchronous wait cannot
block its own diagnostic. It prints the active nested phases and their elapsed
milliseconds, plus the last 16 phase events. Successful tests are silent even if a
later test fails. The existing fixture cleanup removes the journals.

Outside the wrapper, caught failures still print a diagnostic; a blocked standalone
test needs an independent reporter. The intended CI command already uses the wrapper.
The new instrumentation can affect the timing of an intermittent runtime bug; a
passing diagnostic run is not a fix proof.

## CI evidence

The attached logs use Bun 1.4.2 (`744846f84`).

- `green-838d81e6.log:590,600,794-804`: the same wrapped command executes;
  `graph.server_cli` passes and `build.product_two_roots` passes in 1485.21 ms.
  The root unit step runs approximately 16:47:54–16:51:18 (3m24s).
- `hang-c7954d25.log:439-483`: historical baseline succeeds in 4261.26 ms;
  the build fixture emits both TUI trees; `graph.server_cli` passes at 19:13:35.576;
  exactly 120 seconds later Bun prints `killed 2 dangling processes`. No test result
  follows before the wrapper's 20-minute execution deadline at 19:32:35.451.
- `hang-0244d4ca.log:440-480`: the historical-baseline unit test first times out
  at 30 seconds, killing two dangling processes. The build fixture subsequently
  times out at 120 seconds. Other synchronous spawn failures occur later, including
  `git` ENOENT at lines 1745–1771. A broken spawn result is not proof that Git was
  actually uninstalled.

## Linux experiments before the diagnostic change

Exact command, after core build:

```sh
bun scripts/prepare-common-auth-public-consumer.ts bun test --isolate \
  packages/core/src packages/opencode/src \
  packages/opencode/scripts/build-tui.test.ts \
  packages/opencode/scripts/smoke-tui-pack-install.test.ts \
  packages/pi/src test/ packages/e2e-tests/docker/ga-contract-inputs.test.ts
```

Bun was 1.4.2 (`744846f84`). Commands ran through the Linux runner; builds and suites
were serialized.

| Experiment | Result |
| --- | --- |
| Exact full command, core built first | 194.26 s; 3320 pass, 10 fail; no hang |
| Exact full command, full source build first | 199.62 s; 3322 pass, 8 fail; no hang |
| Wrapped build-TUI file alone, 2 CPUs | 53.66 s; 23 pass, 0 fail |
| Nine original prefix files, native Linux discovery order | 130.10 s; 198 pass, 1 fail; missing historical Git object |
| Genuine historical build then current TUI file, order-preserving copies | 51.55 s; 55 pass, 0 fail |
| Full CI-ordered nine-file prefix with genuine historical objects | 188.59 s; 174 pass, 3 fail, 1 error; baseline timeout then build fixture timeout |
| Exact full command with historical object mirror and temporary spawn-entry/return logging | 204.24 s; 3326 pass, 4 fail; no hang |
| Reduced migration-crash → smoke → build prefix | 117.35 s; 150 pass, 0 fail |

The full-suite failures are not a green verification: this runner lacks Docker,
historical Git objects, and the private toolchain's complete offline install cache.
Additional migration crash-seam and background approval failures were intermittent.
A real historical-object mirror removes the missing-object failure; it does not
remove Docker/cache limitations.

The Linux runner's file discovery differs from CI. Native discovery places many
core files and `build-tui.test.ts` before the smoke file, whereas the CI logs place
smoke immediately before build-TUI. Diagnostic copies in the same source directories
were prefixed numerically to retain relative imports while forcing the logged order.
They were temporary and are not delivered.

The observed nine-file order was environment, dev, lifetime-isolation, public-consumer,
migration-crash, migration-temp-recovery, producer closure, smoke, build-TUI. Only
copies were renamed; neither the public wrapper nor test bodies were bypassed.

To reach the genuine baseline, a local Git object pack contained the actual complete
`45625093922278e7d8f1f1415df42bbc0ca1883e` tree and commit. In each Linux job a private
bare repository under `$TMPDIR` received it through `git index-pack`. A PATH shim
redirected **only** `git archive <that exact revision>` to the genuine object mirror;
all other Git calls used `/usr/bin/git`. No expected test output or archived source
was fabricated. The remote repository metadata remained read-only.

## Reproduced process evidence

External `/proc` observations during the failing ordered prefix:

```text
38.844s  historical-baseline test begins
54.012s  Bun test PID 50: state R, wchan 0, CPU ticks [1825,515]
54.012s  esbuild PID 578: state S, wchan unix_stream_data_wait, CPU ticks [10,1]
54.012s  /proc/locks empty; no live compiler child visible
68.899s  killed 2 dangling processes
68.919s  historical-baseline test fails after 30000.99ms
68.920s  build-TUI fixture begins
84.035s  Bun test PID 50: state R, wchan 0, CPU ticks [4822,515]
188.968s killed 1 dangling process
188.968s Bun test PID 50: state R, wchan 0, CPU ticks [15306,515]
188.59s  suite finishes with baseline timeout and 120s fixture timeout
```

The wrapper was sleeping in `ep_poll` and consuming little CPU. The main test process
was spinning; the esbuild service was idle rather than compiling or holding a visible
file lock. These observations do not establish which internal Bun poll/handle was
miscounted, or which exact awaited operation lost completion.

Upstream Bun PR <https://github.com/oven-sh/bun/pull/40078> describes a matching
`spawnSync`/GC poll-accounting defect: main-loop finalizers can release counters against
`spawnSync`'s isolated loop, causing later calls to spin without `epoll_wait` until a
timeout. Issue <https://github.com/oven-sh/bun/issues/34069> reports isolate-dependent
Linux spawn hangs. These are corroborating hypotheses, not a proved diagnosis here.

## History and remaining attribution gap

First-parent changes after the last green revision:

```text
6a5c7824  entry-surface plugin disposal (parent 838d81e6)
28adcb76  vault wording merge (first parent 6a5c7824)
0244d4ca  background approval merge (first parent 28adcb76)
c7954d25  tree-identical CI rerun (parent 0244d4ca)
cbf80ced  Windows vault CI merge (first parent c7954d25)
```

The historical-baseline unit test was introduced earlier, by `0083740e`, whose parent
is `35c395a2`; `838d81e6` already includes it. That test performs Git archive/extraction,
two real TypeScript builds, inline esbuild bundles, and the archived TUI build in the
Bun unit process. The separate `smoke:tui` integration step also builds the baseline.
The later changed OpenCode test files do not run before the logged stopping point.
The required merge-parent/merge execution comparison is not complete, and no merge is
claimed as the cause. The parent requested a ten-run scratch removal experiment before
considering relocation of the heavy historical integration check; that experiment's
result will be reported separately.

## Verification of the diagnostic commit

- Root `bun run typecheck`: passed; TypeScript 6.0.3. The no-emit gates are silent on
  success; embedding reports were current and the strict declaration check used 78
  roots in both NodeNext and Bundler.
- Root `bun run build`: passed; Bun 1.4.2, two audited library bundles, both TUI roots,
  206 OpenCode and 141 Pi declaration files finalized.
- `bun test --isolate test/build-phase-clock.test.ts packages/core/src/__fixtures__/public-consumer-command.test.ts`:
  15 pass, 0 fail, 55 assertions, 4.01 s, including nine existing ownership/lifecycle
  tests and six new clock tests.
- Wrapped original build-TUI and smoke files with genuine historical objects:
  55 pass, 0 fail, 433 assertions, 48.85 s. Neither output stream contained
  `[build-test-phase-clock]` on this green run.
- `bun run lint` and `bun run format:check`: passed; Biome 2.5.3, each checked 458 files.
- AFT inspection's TypeScript analyzer was unavailable because mise failed during
  initialization. The authoritative root TypeScript gates above passed.
- Staged comment review covered all seven source/test files, including both new helper
  comments, and flagged none.

Non-vacuity control: after staging the live state and confirming an empty unstaged diff,
the deadline-report predicate alone was replaced with `false` and marked
`NON-VACUITY BREAK`. The unstaged diff was one file, one insertion/one deletion.
Only `phase clock reports the exact overdue await once and stays silent before its deadline`
failed (expected length 1, received 0); all five other clock tests passed. The helper
was restored from the staged live version, touched, and the unstaged diff was empty.
