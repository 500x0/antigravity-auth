# OpenCode 2

The unified `@cortexkit/opencode-antigravity-auth` package supplies both server and terminal user interface (TUI) entries for OpenCode 1 and OpenCode 2 general availability (GA). The package declares OpenCode `>=2.0.22` support; the repository's [pinned host input](../../e2e-tests/docker/ga-binary-pin.json) is `2.0.22`. A declared range is not evidence that every later host/runtime combination has been exercised.

## Install and register

Quit all OpenCode and Pi processes, then use the [guided setup](CONFIGURATION.md#guided-setup):

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Setup configures registration but does not complete OpenCode 2's native Google connection. Existing legacy OpenCode pools need [offline migration](MIGRATION.md) before login.

For manual directory registration, the shipped top-level `server.js` and `tui.js` forward to the package's public `./server` and `./tui` entries:

```jsonc
{
  "plugins": ["/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth"]
}
```

The [pinned harness](../../e2e-tests/src/opencode-ga-harness.ts) uses an absolute instrumented wrapper directory with those entries. The directory example follows the shipped forwarders, **not a verified GA npm-installer command**. Direct npm-spec registration and host CLI installation syntax are not established here. Consult the matching host's documentation; do not reuse V1's singular `plugin`, `opencode plugin`, or `tui.json` recipe.

Do not copy the harness's synthetic Google key or mock `baseURL` into real configuration. Its default fixture config has no user model map; no copied model-map requirement is established. Models use `google/…`; the plugin supplies the Antigravity catalog.

## Pool browser login

1. Start the configured host and run `opencode auth login`.
2. Select **Google**, then the login method **Google (antigravity-auth pool, browser)** (`antigravity-auth-pool-browser`). If that method is absent, stop and use a plugin build that provides it; a native Google key/login is not a substitute.
3. Complete Google consent. The listener at `http://localhost:51121/oauth-callback` handles the browser callback and PKCE exchange. Only one login can bind that listener at a time. Use the [callback troubleshooting guide](TROUBLESHOOTING.md#port-already-in-use) for an occupied port or remote browser.
4. Select the saved **Antigravity** connection. The browser choice above is a **login method**; Antigravity is the **saved connection label**, not a third method.
5. Open `/antigravity` to inspect Accounts and Quota, then select a supported `google/antigravity-…` model.

Pool login persists credentials in the plugin's local repository before returning a non-secret common-auth Google placeholder to the host. It may initialize a truly fresh store at the location's resolved account path, but refuses a pool awaiting migration. Additional logins must have distinct identities; use the account reauthorization action to replace an existing account's credentials. Local login requires current local authority; it is not authorized while approved vault custody is active.

For vault mode, obtain enrollment approval from the Claustrum vault operator first, then use the other Google login method, **Use approved Antigravity vault** (`antigravity-vault`). Both methods save under **Antigravity**. The vault method is not local OAuth. See [vault activation and disconnection](VAULT.md).

## Request ownership: marker-only support boundary

The plugin owns a Google request exactly when the **host-prepared `x-goog-api-key`** equals common-auth's public `placeholderSecret('google')` byte-for-byte. Antigravity is the only currently supported producer of that Google placeholder. A hypothetical second producer of the same provider marker is outside the supported composition; the marker does not identify an enrollment or login method.

Ownership is checked before title, model, retirement, or body handling. It does not look up the active connection or allowlist method IDs. Requests carrying a real Google key or native Google OAuth credential pass through untouched: no body read/clone/rewrite, account acquisition, response adaptation, or plugin retry decision. Switching connections after preparation cannot change those outgoing bytes. Existing vault placeholders do not need rewriting or forced reconnection.

For owned content requests, title routing precedes primary model checks; supported primary, compaction, and generate requests use the loopback bridge and shared executor. Owned unsupported/non-content paths or off-catalog models refuse locally instead of sending a placeholder to an external provider. An empty or unavailable pool produces a native error, not fabricated HTTP 200 assistant success or a fallback to an ordinary Google credential. Approved vault authority selects vault credentials and never falls back to the local pool.

The host retry API has session identity but no exact HTTP-attempt ownership identity. The plugin remembers whether each session's latest Google transport was owned (up to 512 entries); latest-owned uses its no-host-retry policy, while latest-unowned, missing, or evicted state leaves the host decision unchanged. Session cleanup and teardown retire entries. Mixed-ownership concurrency within one session remains a heuristic limitation, not a promise of exact attempt attribution. Response adaptation remains tied to the actual request/bridge record.

## UI and evidence limits

GA's sidebar and menu use location-scoped snapshots through native host RPC, not V1's sidebar/port-file configuration. Credentials, project IDs, and fingerprints do not belong in renderer snapshots or support reports. See [commands](COMMANDS.md) and [credential safety](CONFIGURATION.md#security-and-redaction).

The [released-host contract](opencode2-ga-2.0.22-contract.md) records pinned contracts and proof obligations. Source tests, a packed TUI smoke run, and a native-host run are distinct evidence. This guide does not claim a native gate has run or that fixture-based Google login proves Google's live OAuth acceptance or account entitlement. Model captures also have limits: [Argon MEDIUM/HIGH remain unverified live](MODEL-VARIANTS.md#gemini).
