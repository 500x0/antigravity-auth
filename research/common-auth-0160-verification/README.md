# common-auth 0.16.0 candidate adoption

The input is the parent-supplied repacked common-auth 0.16.0 archive, not a registry release. The original common-auth 0.16.0 candidate was built from commit `9f61c6a5` in the common-auth repository; comparison with that archive confirms that the repack changes only `dist/setup/command.js`.

## Measured identity

- Archive: `tools/common-auth-build/inputs/cortexkit-common-auth-0.16.0.tgz`, 279,960 bytes.
- Archive SHA-256: `0093e55bc1dbc6a0fc7872214038fa5bff0ec8c41c92f26eda3b3ffb07c531c2`.
- Uncompressed tar SHA-256: `c97eada6d0aab5807ac24a4cfa5eb16a2248f4a0b3e9731cbf323033e6771de4`.
- Full publication: 215 files, 1,038,705 payload bytes.
- Sorted inventory SHA-256: `ba80b6ef8b8cf56b9c3321e17b04e62b32cbac99946482e032535ecd2b2ec894`.
- Manifest SHA-256: `2bda410a6de08a1f53105f34b92e64db5bf958eb246283d64adb0a7e21527e2b`.
- Private compiler lock SHA-256: `41281c586ba052288ef4a92305aaf5e60e5e2587d33a646d6ca3e09d0a3d0fca`.
- OpenCode's public-root closure: 176 files, 924,027 bytes. Core's closure: 133 files, 747,481 bytes. Unreachable setup declarations and the empty `setup/types.js` are not embedded.

Both trees and their provenance were regenerated with `bun packages/opencode/scripts/embed-common-auth.ts` and `bun packages/core/scripts/embed-common-auth.ts`. Private lock refresh used `bun install --cwd tools/common-auth-build --offline --ignore-scripts`; a subsequent frozen offline install verified it. Workspace install used `bun install --offline --ignore-scripts` after manifest changes. No lifecycle scripts or registry acquisition were needed.

## Candidate findings versus integration changes

- Without an `insula` option, the new consumer tick returns immediately from `refreshInsulaQuota()`. Antigravity supplies no such option. The added roster method is used by that opt-in path; existing serving methods remain unchanged. The custody implementation is byte-identical to 0.15.0, with only its declaration extended.
- The common-auth owner confirmed that vault clients should be imported statically and supplied by the consumer's installed dependencies, not inlined or split into lazy bundle chunks. Loading `./claustrum` statically resolves `claustrum/index.js -> insula.js -> @cortexkit/subc-client`; `index.js -> consumer.js -> @cortexkit/claustrum-client` is already static, and claustrum-client depends on subc-client 0.16.x. The first build could not resolve the newly direct import from the embedding location. Our accommodation declares the already locked `0.16.1` client in core and declares both clients directly in OpenCode for its setup CLI. Both clients remain external in every product bundle: one shared installed copy, no inlining or emitted lazy chunk. This introduces no new resolved package, and the embedded bytes remain verbatim.
- Only compiler/archive identity expectations in `build-tui.test.ts` changed. Its renderer import-graph assertions remain unchanged.

## Initial verification (Bun 1.4.2, TypeScript 6.0.3, Linux)

- Typecheck passed, including strict embedded declarations in NodeNext and Bundler.
- Build passed after declaring the static subc-client dependency.
- Exact publication and closure tests passed, including the independent core closure.
- All 14 unit vault suites were run. The real native V1 activation suite passed. The packed V1 vault suite could not reach the real host because its separate parent-supplied `opencode-linux-x64-1.17.13.tgz` is not available in the Linux runner.
- Compiler fixture installs cannot reconstruct a fresh offline cache on the runner; the main private compiler installation succeeds. Docker is unavailable for the clean-input fixture. These are runner limitations, not candidate behavior findings.

Final setup integration gates and exact counts are recorded in the delivery declaration.

## Setup integration decisions and verification

The standalone `setup` command delegates flags, host detection, registration and process fencing to the verified common-auth contract. Its OpenCode local callback reuses OAuth and the unchanged `migrate --offline --yes` CLI path only for a legacy pool. The parent approved reported no-ops for fresh or already migrated profiles, vault-only OpenCode, and Pi (whose credentials live in native `auth.json`). Local setup refuses custody placeholders or approved/unreadable vault authority. OpenCode vault activation refuses a competing native login; Pi uses its existing stash/slot editor. Shared Pi path resolvers moved to core so the CLI and extension use one implementation; setup passes that resolved directory to common-auth's `PI_CODING_AGENT_DIR` detection seam.

A noninteractive `setup --dry-run` plans the `--yes` path without writing, signing in, enrolling or migrating. The original common-auth 0.16.0 command refused to plan without a terminal unless `--yes` was supplied. The repacked command allows that preview without requesting confirmation; the real CLI regression covers `--dry-run` alone with ignored stdin and piped output, alongside the existing `--yes` cases. The contract uses a singular `plugin` registration for `--opencode=both`, as supplied by common-auth; the tests establish its planned config and preservation, not a live OpenCode 2 npm registration. No real OAuth or enrollment ceremony, Google request, or OpenCode 2 process was started by setup tests.

The clients are runtime dependencies of the CLI package because setup statically imports enrollment and bundle outputs keep clients external. Both resolve the releases already present through core (`claustrum-client 0.9.0`, `subc-client 0.16.1`), rather than adding a new package or host-only dependency. The manifest assertion and historical smoke graph allow only these exact direct pins, while preserving all previous peer/version negative controls. `jsonc-parser` also stays external: bundling its AMD implementation made Node fail on `./impl/format`. It was already a runtime dependency. The CLI now checks real entry paths on Node 20, where `import.meta.main` is unavailable, including package-manager bin symlinks.

- Final Linux typecheck and builds passed with Bun 1.4.2 and TypeScript 6.0.3 (85 strict embedded declaration roots; two audited bundles; 26 V1 and 12 GA renderer files per tree).
- Full unit invocation: 3,315 passed, 31 failed. Four stale released-status receipt checks, a missing packed-core fixture subc-client link, and the packed server's JSONC bundling issue were corrected without changing behavioral expectations. All seven impacted test files then passed: 230 tests, including 14 setup entry/callback tests. The background quota timing failure passed alone. Remaining full-suite limitations are fresh private-tool offline caches, unavailable Docker, and Git safe-directory configuration inside the public-consumer wrapper.
- Deterministic e2e: 79 passed. The initial no-accounts test exceeded its 5-second deadline; the complete rerun passed.
- Pack/install smoke with network: four fresh packs, eight product consumers and four baseline consumers passed for npm/Bun with and without lifecycle scripts. The installed graph requires exactly one locked copy of each vault client, and the installed bin's setup preview runs under owned HOME/XDG/Pi/database paths.
- Format/lint: Biome 2.5.3, 459 files checked. Mutation catalogue: ckdev-mutate 0.12.1 passed; command rows without a list command remain reported as test-name-unverified.
- Editor diagnostics were partial: Biome reported only import/style information, while the TypeScript language server could not initialize through mise. The repository typecheck is the authoritative successful gate.

The publication pin was also deliberately replaced with an incorrect hash: only `producer.verbatim_map` failed, while `producer.slim_runtime_reachability` stayed green. The emitter was then restored to the staged live state, with an empty unstaged diff. This demonstrates that the publication test rejects a wrong input pin rather than merely comparing the generated tree with itself.

After restoring the bundle policy, the final focused CLI/manifest/build-TUI run passed 66 tests and the packed-graph unit run passed 31 tests. The unchanged renderer graph tests passed. A separate control removed subc-client from the actual CLI/index bundle external list, rebuilt the product, and failed only `real setup CLI entry > server and CLI keep both vault clients external without lazy chunks or inlining`; `setup plugin callbacks > local migration uses existing storage status: store` remained green. The one-file unstaged diff was nonempty during the control and empty after restoration. The restored product was rebuilt and tested before committing.

## Repacked preview verification

The replacement archive has the same 215 members and public-root closures as the original common-auth 0.16.0 candidate. Comparing every member found exactly one changed payload, `package/dist/setup/command.js`. After both owning scripts regenerated the trees, the only changed embedded payload was OpenCode's `setup/command.js`; both `source-output.json` provenance records changed. Every generated payload was independently compared with its archive member, including all 133 unchanged core files.

The private compiler installation used a fresh worktree-local Bun cache at `node_modules/.common-auth-r2-cache`, with lifecycle scripts disabled and offline mode enabled. The lockfile's previous SHA-512 integrity value (SRI) did not match the repacked archive, so Bun correctly rejected the first install attempt. Updating that one measured integrity pin allowed the normal and frozen offline installs to succeed, and the installed `dist/setup/command.js` matched the repacked archive exactly. No dependency versions, manifest declarations or other lock entries changed.

Linux verification used Bun 1.4.2, Node 24.21.0, TypeScript 6.0.3 and Biome 2.5.3. Typecheck and the complete product build passed. All 15 setup tests passed after rebuilding the restored CLI. The eight independent producer/closure tests, five embedding integrity/inventory/regeneration/attribution/refusal tests and 23 build-TUI tests passed. The unchanged renderer graph assertions still passed. The complete-publication admission run passed 11 tests. The packed smoke passed four fresh packs, eight product consumers and four historical baseline consumers, including its installed CLI preview. Biome format and lint each checked 459 files with no fixes required.

The new no-write assertion was also checked against an actual CLI mutation: a temporary file write after dry-run planning failed only `real setup CLI entry > dry-run alone without a terminal reports plans without any filesystem changes`; `setup plugin callbacks > local migration uses existing storage status: store` stayed green. The CLI source was restored from its pre-mutation copy saved in the Git index. An empty unstaged diff confirmed that the temporary write had been removed without losing the implementation changes, and the restored CLI was rebuilt before the successful 15-test setup run.

Runner limitations remain for `embed.clean_input` (Docker is unavailable) and `build.private_toolchain` / `build.repo_hygiene` (their fresh offline private-tool installs lack registry packages in the runner cache). Git ownership refusal in the historical smoke fixture was resolved with an exact-worktree, command-scoped `safe.directory`. The remote runner kept the full shell command in PID 1's argument list. When a package-scoped OpenCode build and setup tests shared that command, the process check interpreted its `--cwd packages/opencode build` argument as an active OpenCode host. Using `bun run build` at the repository root avoided that false match without altering the process fence or tests. One unrelated account-grant timing test timed out in the combined run and passed alone.
