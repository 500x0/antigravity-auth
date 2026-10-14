# Unpublished common-auth 0.15.0 candidate verification

This branch verifies the supplied candidate; it does not publish or adopt registry
bytes. Any later adoption must independently compare the published artifact with
this candidate.

## Artifact identity

- Candidate: `tools/common-auth-build/inputs/cortexkit-common-auth-0.15.0.tgz`
- Compressed size: 258,947 bytes; archive members: 191, totaling 964,546 payload bytes.
- Archive SHA-256: `c60024a6da913239cd0e1e36fce921c03e695358be92573a3f6c1d89d51b2dc2`
- Decoded tar SHA-256: `40d133eec3295a59b77a2399450507f184cd816c93773f49b807fdf2e23ac0f3`
- SRI: `sha512-1zm7pO6iI7CdDc2FgAB2v6nFd8km3qWJxcCf76+Ib7rrRdl/fGeVI914MKzRi5K1+GasOQZ3MOLQ8b09N8KvOw==`
- Embedded public-module payloads selected for OpenCode: 158 files, 853,069 bytes;
  the core package's embedded subset: 131 files, 724,806 bytes. These counts exclude
  the generated provenance JSON and license notice.
- Private compiler lock SHA-256: `a800738e8be32885081d70de5155d7b14d97995f81f305b9a6d5830f61fa23fb`
- Runtime private-files resolves to 0.1.0. Claustrum-client is pinned to 0.9.0;
  its store dependency resolves to 0.2.2 under the declared `^0.2.1` range.

The archive SHA-256 and decoded-tar SHA-256 supplied with the candidate were
recomputed before copying it into the build inputs. The compiler lock was refreshed
offline with lifecycle scripts disabled. Both embedded trees and provenance were
regenerated only through their owning scripts. Root installation also refreshed
stale workspace lock metadata from 3.0.2 to the existing 3.0.3 manifest values.

## Linux verification

Toolchain: Bun 1.4.2 (744846f84), Node 24.21.0, TypeScript 6.0.3,
Biome 2.5.3, ckdev-mutate 0.12.0. `packages/core` was built before testing or
building its OpenCode and Pi adapters.

| Gate | Observed result |
| --- | --- |
| `bun run typecheck` | Passed; workspace checks plus 78 strict embedded declaration roots under NodeNext/Bundler and the 7-file client type closure. |
| `bun run build` | Passed; copied 131 core payloads, finalized 207 OpenCode and 149 server declaration files, emitted 26-file V1 and 12-file GA renderer variants, and built Pi. |
| `bun run test` after a fresh build in the same remote job | **Not fully passed:** 3,365 passed, 3 infrastructure failures, 3,368 tests across 173 files. Failures: `build.private_toolchain`, `build.repo_hygiene` (default offline cache absent), and `embed.clean_input` (Docker absent). |
| Private offline-install tests, run directly with an explicitly populated cache | Passed: `build.private_toolchain` and `build.repo_hygiene`, 2 tests and 372 assertions. A fresh scratch compiler install populated 106 locked packages with scripts disabled; the tests then exercised frozen offline installs. The root public-consumer wrapper does not forward the cache override, so this does not turn its two failed tests into root-suite passes. |
| `bun run test:e2e` | Passed: 79 tests across 5 files. |
| `bun run --cwd packages/opencode smoke:tui` with registry access | Passed for both the candidate-only step and the client-0.9.0 step: 4 fresh packs, 8 product consumers, 4 historical baseline consumers. |
| `bun run format:check` | Passed: 452 files, no fixes. |
| `bun run lint` | Passed: 452 files, no fixes. |
| Explicit vault/enrollment unit suites | Passed: 172 tests across 13 files. The full unit run also passed the genuine enrollment cases in plugin-entry, auth-loader and Pi stream. |
| Additional official-host vault e2e files | **Not fully passed:** 6 passed, 2 namespace prerequisite failures across 8 tests. The two official-host execution tests refused because the remote namespace exposes interfaces besides loopback; no namespace check was weakened. |
| `ckdev-mutate check` | Passed: all 25 catalog anchors and exact test names verified. |
| `ckdev-mutate run --all --allow-dirty --report …` | Passed: all 25 controls CAUGHT, no baseline failures or reported collateral failures. `mutations.json` preserves the runner's baseline and named failing output. Broad package-test mutation grading was not requested or run. |

Every required root gate was executed without changing its selection or assertions.
The three unit-suite infrastructure failures and two additional official-host
namespace refusals remain limitations, not successful checks. The private-cache
controls were verified separately, rather than skipped or weakened.

## Built-output boundary proofs

`graph.renderer_private_files_external_dynamic_import` checks the emitted raw and
compiled V1 renderer trees, not just source imports. Each tree has exactly one
private-files specifier, used only as an external dynamic import, and contains no
source from the private-files package. OpenCode 2's GA renderer still permits only
its existing host-supplied UI module imports; it does not gain a backend dependency.
`graph.server_cli` inspects real esbuild output/metafiles for root, CLI and server,
uses the production bundle externals, and rejects any bundled private-files input.

For two additional deliberate regressions, the current implementation was first
saved in Git's index. Each break recorded a nonempty working diff, ran four named
graph tests, then restored the indexed implementation with `git checkout --` and
`touch` and confirmed an empty working diff:

- Removing private-files from `BUNDLE_EXTERNALS`: `graph.server_cli` failed on an
  inlined private-files loader. `graph.source`, the renderer boundary test and
  `graph.ga_roots` stayed green. Diff: one file, 2 insertions, 1 deletion; empty
  after restoration.
- Rewriting the emitted lazy backend import into a static import in the compiler
  adapter: `graph.renderer_private_files_external_dynamic_import` failed its AST
  call-expression check. `graph.source`, `graph.server_cli` and `graph.ga_roots`
  stayed green. Diff: one file, 9 insertions; empty after restoration.

After both production files were restored, the same four graph tests passed with
70 assertions.

## Candidate findings versus integration repairs

No candidate runtime or declaration failure remains in the verified Linux tests.
Windows native execution and the two official-host network-namespace tests were
not established by this runner, so this record is not a Windows sign-off.

The failures repaired in this repository were fixture assumptions, not changes to
candidate bytes or relaxed security checks:

- The packed-core typing fixture omitted the newly declared private-files package.
  It now links the genuine installed dependency using the existing resolver.
- Four real-enrollment cases used the public-consumer wrapper's temporary folder
  below node_modules. The writable ancestor correctly refused enrollment. Their
  three fixture roots now use owned private folders directly under system temp,
  following the existing POSIX `/tmp`/Windows `tmpdir()` convention.
- Version, hashes, byte counts, closure edges and historical byte-comparison
  assertions were refreshed to measured candidate values, with the new lazy
  private-files import admitted explicitly and unrelated imports still refused.

No removed `acceptsAncestor` or `ancestorIdentityContext` use was found; genuine
0.9.0 typechecking passed without replacement casts or API shims. The packed
baseline uses the same fresh core as the candidate consumer, so its private-files
and store rows are already present; only the plugin's explicit private-files
runtime declaration is an additional allowed dependency declaration. Extra
installed packages and declaration changes remain rejected.

Windows logger flushing can now be asynchronous, but this repository has no
non-generated calls to `flushLogs()` that could be awaited during shutdown.
Release/CI preflights
already check the owning embed script before each private compiler install and
retain that ordering. The compiler-lock digest belongs to build-tui.ts in this
checkout; common-auth-runtime.ts has no compiler-lock digest to update.
