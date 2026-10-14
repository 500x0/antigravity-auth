# Windows CI bundle and embedding fixes

## Reproduced byte difference

`test/windows-ci.test.ts` checks out the real embedding generator through Git
with `core.autocrlf=true`, then imports that checked-out generator and writes a
fresh embedding from the pinned archive. An unprotected text sentinel must
become CRLF, proving the fixture actually exercises checkout conversion. The
regenerated manifest is compared with the repository's `source-output.json`,
not with another invocation of the same checked-out generator.

Before protecting the generator in `.gitattributes`, the Linux reproduction
failed at zero-based byte offset **2099** of `source-output.json`. The only JSON
field that differed was `generator.sha256`:

- Committed/LF: `ea3b07287e2f0baf0a8b2b68ee6bb90638896a5376bb0d7a9414e0f3e9b26d23`
- Windows-style CRLF checkout: `2093b8aed9f08f2d4f9b6adfefa15e4a638992a30ff164d4399137ebfb1169cf`

The generator hashes its own bytes when building the manifest. Its source had
no checkout attribute, unlike the archive and embedded payload. Protecting
exactly `packages/opencode/scripts/embed-common-auth.ts` preserves the existing
manifest bytes without weakening the byte check or changing generated output.
The regression also runs the unchanged emitter's byte check on its output.

## Bundle boundaries

Both Windows workflow esbuild commands now obtain their external flags from
the product build's exported `BUNDLE_EXTERNALS`. PowerShell splats those flags
into esbuild, leaving the same five dependencies external as the product CLI.
The previous core-only external flag is replaced, not appended, so the sets
match exactly. Frozen workspace dependencies supply the external packages at
runtime.

The regression parses the actual workflow YAML, evaluates each job's flag
expression, runs each esbuild command with those flags, inspects its metafile,
and loads each bundle using Node. The migration CLI runs with `--help`; the
vault module is imported without invoking enrollment or serving requests.

## Verification boundary

The local reproduction and checks run on Linux, not Windows. They establish
the checkout-induced manifest difference and the ESM bundle load behavior.
PowerShell argument splatting, native Windows checkout behavior, vault DACLs,
enrollment, served requests, and safe/unsafe migration still require the
`windows-latest` and `windows-2022` workflow runs. No GitHub diagnostic commit
is needed to reproduce the byte difference on Linux.
