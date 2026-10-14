# common-auth 0.16.0 candidate adoption

The input is the parent-supplied archive built from common-auth commit `9f61c6a5`, not a registry release.

## Measured identity

- Archive: `tools/common-auth-build/inputs/cortexkit-common-auth-0.16.0.tgz`, 279,870 bytes.
- Archive SHA-256: `e7513fdc5fed846cbef09e432eb0ce76443dbc2793a8189954f1d3a1271bd34e`.
- Uncompressed tar SHA-256: `bdf56084c8df6819a6db7ff07b5040c51ecd87683d9d07fd4912a534b7fb998e`.
- Full publication: 215 files, 1,038,467 payload bytes.
- Sorted inventory SHA-256: `ba80b6ef8b8cf56b9c3321e17b04e62b32cbac99946482e032535ecd2b2ec894`.
- Manifest SHA-256: `2bda410a6de08a1f53105f34b92e64db5bf958eb246283d64adb0a7e21527e2b`.
- Private compiler lock SHA-256: `c48bd0a0ac7575fd31201c3340c88769f0d0fa2104be89c93bf095e228598845`.
- OpenCode's public-root closure: 176 files, 923,789 bytes. Core's closure: 133 files, 747,481 bytes. Unreachable setup declarations and the empty `setup/types.js` are not embedded.

Both trees and their provenance were regenerated with `bun packages/opencode/scripts/embed-common-auth.ts` and `bun packages/core/scripts/embed-common-auth.ts`. Private lock refresh used `bun install --cwd tools/common-auth-build --offline --ignore-scripts`; a subsequent frozen offline install verified it. Workspace install used `bun install --offline --ignore-scripts` after manifest changes. No lifecycle scripts or registry acquisition were needed.

## Candidate findings versus integration changes

- Without an `insula` option, the new consumer tick returns immediately from `refreshInsulaQuota()`. Antigravity supplies no such option. The added roster method is used by that opt-in path; existing serving methods remain unchanged. The custody implementation is byte-identical to 0.15.0, with only its declaration extended.
- Loading the candidate's `./claustrum` barrel now statically resolves `@cortexkit/subc-client`, even with Insula disabled. The first Linux build failed to resolve it. Core therefore declares the already locked `0.16.1` client directly at runtime, and OpenCode declares it for bundling. This adds no new resolved package: claustrum-client already depends on it. The embedded bytes remain verbatim.
- Only compiler/archive identity expectations in `build-tui.test.ts` changed. Its renderer import-graph assertions remain unchanged.

## Initial verification (Bun 1.4.2, TypeScript 6.0.3, Linux)

- Typecheck passed, including strict embedded declarations in NodeNext and Bundler.
- Build passed after declaring the static subc-client dependency.
- Exact publication and closure tests passed, including the independent core closure.
- All 14 unit vault suites were run. The real native V1 activation suite passed. The packed V1 vault suite could not reach the real host because its separate parent-supplied `opencode-linux-x64-1.17.13.tgz` is not available in the Linux runner.
- Compiler fixture installs cannot reconstruct a fresh offline cache on the runner; the main private compiler installation succeeds. Docker is unavailable for the clean-input fixture. These are runner limitations, not candidate behavior findings.

Final setup integration gates and exact counts are recorded in the delivery declaration.
