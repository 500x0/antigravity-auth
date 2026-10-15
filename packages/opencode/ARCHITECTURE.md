# Architecture

The fetch-interceptor details below describe OpenCode 1. The unified package also supplies an OpenCode 2 server and terminal UI: see the [current root architecture](../../ARCHITECTURE.md#opencode-2-ga-server-and-location-services) and [OpenCode 2 guide](docs/OPENCODE-2.md). OpenCode 2 registers pool-browser and approved-vault login methods under a saved `Antigravity` connection. The adapter handles requests carrying the host-prepared common-auth Google placeholder, not requests selected by active connection metadata. Real Google keys/native credentials pass through unchanged. OpenCode 1 instead leaves the saved Google login unused while it uses vault credentials authorized by the Claustrum vault operator's approval of [host enrollment](docs/VAULT.md#enroll-and-activate).

## Pattern Overview

**Overall:** OpenCode plugin — fetch-interceptor that transforms Gemini API requests into Antigravity (Cloud Code Assist) format, with OAuth multi-account rotation, quota management, session recovery, and cross-model compatibility.

**Key Characteristics:**
- Single `createAntigravityPlugin` factory in `src/plugin/index.ts` that returns the full OpenCode plugin surface
- All outbound traffic to `generativelanguage.googleapis.com` is intercepted and rewritten before it leaves the process
- Plugin content requests use Antigravity transport and its User-Agent; the retired Gemini CLI request/quota path is not a fallback
- All state (accounts, rate-limit counters, health scores) is module-level; the plugin factory runs once per session
- Config schema is Zod-validated; environment variables always override file config

---

## Layers

**Entry Point / Composition Root:**
- Purpose: Initialize shared module state, wire plugin factories, and return the OpenCode hook surface
- Location: `src/plugin/index.ts`
- Contains: `createAntigravityPlugin` factory and subsystem wiring
- Depends on: Hook, auth, tool, account-access, OAuth, and fetch factories
- Used by: OpenCode host via `@opencode-ai/plugin` contract

**OAuth / Credentials:**
- Purpose: OAuth token exchange with Google, token refresh, access-token lifecycle
- Location: `src/antigravity/oauth.ts`, `src/plugin/auth.ts`, `src/plugin/token.ts`
- Contains: `authorizeAntigravity`, `exchangeAntigravity`, `refreshAccessToken`, `AntigravityTokenRefreshError`, token expiry helpers
- Depends on: `@openauthjs/openauth`, `src/constants.ts`
- Used by: `src/plugin/oauth-methods.ts`, `src/plugin/auth-loader.ts`, `src/plugin/refresh-queue.ts`

**Request Transform:**
- Purpose: Convert OpenCode/Anthropic-format request bodies into Antigravity (Cloud Code Assist) wire format and back
- Location: `src/plugin/request.ts`, `src/plugin/request-helpers.ts`, `src/plugin/transform/`
- Contains: `prepareAntigravityRequest`, `transformAntigravityResponse`, schema cleaning, thinking-block stripping, tool-hardening injection, cross-model sanitisation, stable system-instruction ordering (prompt → tool hardening → thinking hint) for prompt caching, and streaming cache-stats tracking via `onUsageMetadata` callback
- Depends on: `src/constants.ts`, `src/plugin/transform/`, `src/plugin/thinking-recovery.ts`, `src/plugin/cache/`
- Used by: `src/plugin/fetch-interceptor.ts`

**Model Resolution & Per-Model Transforms:**
- Purpose: Map aliases and public tier names to Antigravity wire model IDs, apply model-specific config, and resolve thinking variants or tier budgets
- Location: `src/plugin/transform/model-resolver.ts`, `src/plugin/transform/claude.ts`, `src/plugin/transform/gemini.ts`, `src/plugin/transform/cross-model-sanitizer.ts`, `src/plugin/model-registry.ts`
- Contains: `resolveModelWithTier`, `resolveAntigravityModel`, `resolveModelWithVariant`, `applyClaudeTransforms`, `applyGeminiTransforms`, `sanitizeCrossModelPayload`
- Depends on: `src/plugin/transform/types.ts`
- Used by: `src/plugin/request.ts`

**Multi-Account Management:**
- Purpose: Track per-account OAuth state, rate-limit cooldowns, quota cache, fingerprints, and daily request usage; select the best account for each request; detect and repair auth storage drift; track session metrics and request rate estimation
- Location: `src/plugin/accounts.ts`, `src/plugin/storage.ts`, `src/plugin/rotation.ts`, `src/plugin/fingerprint.ts`, `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`
- Contains: `AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`, `selectHybridAccount`, `generateFingerprint`, `buildFingerprintHeaders`, `FingerprintVersion` history (max 5), account storage version 4 support with migration, secure POSIX permissions, `detectAuthStorageDrift`, `createAuthDoctorReport`, self-healing repairs, per-family daily request tracking, and in-memory session summaries with hourly rate calculations
- Depends on: `src/plugin/auth.ts`, `src/plugin/quota.ts`, `proper-lockfile`, `xdg-basedir`
- Used by: `src/plugin/auth-loader.ts`, `src/plugin/fetch-interceptor.ts`, `src/plugin/lifecycle.ts`

**Token Refresh Queue:**
- Purpose: Background proactive OAuth token refresh so requests never block on expiry
- Location: `src/plugin/refresh-queue.ts`
- Contains: `ProactiveRefreshQueue`, `createProactiveRefreshQueue`
- Depends on: `src/plugin/accounts.ts`, `src/plugin/token.ts`
- Used by: `src/plugin/auth-loader.ts`, `src/plugin/lifecycle.ts`

**Quota:**
- Purpose: Query Antigravity for per-account quota readings, populate quota caches for [soft-quota filtering](docs/MULTI-ACCOUNT.md#quota-refresh-and-soft-thresholds), aggregate group/window and per-model data, and handle endpoint fallback and stale-cache fail-open behavior
- Location: `src/plugin/quota.ts`, backed by `packages/core/src/quota-manager.ts` in the repository
- Contains: `checkAccountsQuota` and account quota projections. Core's `fetchQuotaSummary` calls `retrieveUserQuotaSummary`; `aggregateQuotaSummary` builds group/window readings. If summary fetching fails, `fetchAvailableModels` and `aggregateQuota` provide fallback readings. Both sources use Antigravity endpoints, not a parallel Gemini CLI quota source.
- Depends on: OAuth token utilities, `src/plugin/model-registry.ts`
- Used by: `src/plugin/fetch-interceptor.ts`, `src/plugin/oauth-methods.ts`, `src/plugin/accounts.ts`

**Session Recovery:**
- Purpose: Detect interrupted tool executions (`tool_result_missing`) and malformed thinking blocks; inject synthetic completions to restore session
- Location: `src/plugin/recovery/` (`index.ts`, `types.ts`, `constants.ts`, `storage.ts`), `src/plugin/thinking-recovery.ts`
- Contains: `createSessionRecoveryHook`, `isRecoverableError`, `handleSessionRecovery`, `analyzeConversationState`, `closeToolLoopForThinking`
- Depends on: OpenCode session client API
- Used by: `src/plugin/event-handler.ts`

**Signature Cache:**
- Purpose: Persist and recall Claude thinking-block signatures across requests and restarts when `keep_thinking` is enabled
- Location: `src/plugin/cache/` (`index.ts`, `signature-cache.ts`), `src/plugin/stores/signature-store.ts`
- Contains: `SignatureCache`, `createSignatureCache`, `defaultSignatureStore`
- Depends on: `src/plugin/config/`
- Used by: `src/plugin/request.ts`

**Streaming Core:**
- Purpose: Transform SSE stream payloads line-by-line; cache signatures; inject debug annotations
- Location: `src/plugin/core/streaming/` (`transformer.ts`, `types.ts`, `index.ts`)
- Contains: `createStreamingTransformer`, `transformSseLine`, `transformStreamingPayload`, and `onUsageMetadata` callback to extract usage stats and log cache hit-rate at stream completion
- Depends on: `src/plugin/stores/signature-store.ts`
- Used by: `src/plugin/request.ts`

**Configuration:**
- Purpose: Load, merge, and validate plugin configuration from files and environment variables
- Location: `src/plugin/config/` (`schema.ts`, `loader.ts`, `models.ts`, `updater.ts`, `index.ts`)
- Contains: `AntigravityConfigSchema`, `loadConfig`, `initRuntimeConfig`, `AntigravityConfig`, and settings such as `thinking_warmup`, `cache_warmup_on_switch`, and `max_account_switches`. Old settings for selecting Gemini CLI requests or quota fallback, such as `quota_style_fallback`, are no longer part of validated config.
- Depends on: `zod`
- Used by: `src/plugin/index.ts`, most `src/plugin/` modules via `getKeepThinking()` etc.

**Auto-Update Checker Hook:**
- Purpose: On `session.created`, check npm for a newer plugin version and optionally auto-update the pinned version in `opencode.json`
- Location: `src/hooks/auto-update-checker/` (`index.ts`, `checker.ts`, `cache.ts`, `logging.ts`, `constants.ts`, `types.ts`)
- Contains: `createAutoUpdateCheckerHook`, `getLatestVersion`, `updatePinnedVersion`
- Depends on: npm registry HTTP, OpenCode TUI toast API
- Used by: `src/plugin/index.ts`, forwarded by `src/plugin/event-handler.ts`

**Google Search Tool:**
- Purpose: Expose a `google_search` OpenCode tool that runs separate Antigravity API calls with native grounding tools
- Location: `src/plugin/search.ts`
- Contains: `executeSearch`
- Depends on: `src/constants.ts`, `src/plugin/logger.ts`
- Used by: `src/plugin/index.ts` (registers the tool)

**Logging / Debug:**
- Purpose: Structured per-module logger with TUI integration; detailed debug file logging for request/response inspection
- Location: `src/plugin/logger.ts`, `src/plugin/debug.ts`, `src/plugin/logging-utils.ts`
- Contains: `createLogger`, `initLogger`, `initializeDebug`, `isDebugEnabled`, `logAntigravityDebugResponse`
- Depends on: OpenCode TUI client
- Used by: All modules

**Errors:**
- Purpose: Domain-specific error classes with metadata
- Location: `src/plugin/errors.ts`
- Contains: `EmptyResponseError`, and other typed error classes
- Depends on: nothing
- Used by: `src/plugin/fetch-interceptor.ts`, `src/plugin/request.ts`

**CLI / UI:**
- Purpose: Interactive terminal prompts for login, account selection, project ID entry, per-model availability, and aggregate quota health display
- Location: `src/plugin/cli.ts`, `src/plugin/ui/` (`auth-menu.ts`, `ansi.ts`, `confirm.ts`, `select.ts`, `model-status.ts`, `quota-status.ts`)
- Contains: `promptLoginMode`, `promptAddAnotherAccount`, `promptProjectId`, `showAuthMenu` with two-line layout and status/availability breakdown per model group, `getModelStatusFromAccounts`, `formatQuotaStatusBadge`, `classifyGroupStatus` with stale-cache fail-open, and `buildModelBreakdown` showing available/exhausted model counts
- Depends on: Node.js readline
- Used by: `src/plugin/oauth-methods.ts`, `src/plugin/account-access.ts`

---

## Data Flow

**Request Transform Pipeline:**
1. OpenCode calls plugin `loader()` with the original request — `src/plugin/auth-loader.ts`
2. `isGenerativeLanguageRequest()` confirms the URL matches — `src/plugin/request.ts`
3. `AccountManager.selectAccount()` picks the best OAuth account — `src/plugin/accounts.ts`
4. `resolveAntigravityModel()` maps aliases and public tiers to Antigravity wire model IDs; `resolveModelWithVariant()` applies selected variant config — `src/plugin/transform/model-resolver.ts`
5. `prepareAntigravityRequest()` cleans schema, strips thinking blocks for Claude, injects tool-hardening, and appends Claude thinking hints in a strict stable ordering (original prompt → tool hardening → thinking hint) to maximize prompt cache hits — `src/plugin/request.ts`, `src/plugin/request-helpers.ts`
6. `buildFingerprintHeaders()` attaches per-account device fingerprint — `src/plugin/fingerprint.ts`
7. `fetch()` is called against Antigravity endpoint with Bearer token — `src/plugin/fetch-interceptor.ts`
8. `accountManager.recordRequest()` tracks daily request usage per account and updates in-memory session request counts for rate consumption estimation — `src/plugin/fetch-interceptor.ts`, `src/plugin/accounts.ts`
9. `transformAntigravityResponse()` converts SSE stream back to Gemini API format — `src/plugin/request.ts`
10. Streaming transformer processes each SSE line, caches signatures, injects debug annotations, and fires `onUsageMetadata` callback to log cache hit statistics upon stream termination — `src/plugin/core/streaming/`

**Rate-Limit Retry Loop:**
1. 429 / 503 response received — `src/plugin/fetch-interceptor.ts`
2. `parseRateLimitReason()` classifies the error — `src/plugin/accounts.ts`
3. Retry state computes delay with deduplication — `src/plugin/fetch/retry-state.ts`
4. `AccountManager.markRateLimited()` records cooldown — `src/plugin/accounts.ts`
5. If other accounts available, `selectAccount()` switches — `src/plugin/accounts.ts`
6. Loop retries until success or `max_rate_limit_wait_seconds` exceeded

**OAuth Login Flow:**
1. OAuth authorization invoked by OpenCode host — `src/plugin/oauth-methods.ts`
2. `authorizeAntigravity()` generates authorization URL — `src/antigravity/oauth.ts`
3. Local HTTP listener or manual URL paste captures callback — `src/plugin/server.ts`
4. `exchangeAntigravity()` exchanges code → tokens — `src/antigravity/oauth.ts`
5. Login persistence targets the active shared account repository; host account additions use `commitLogins` rather than writing the legacy `antigravity-accounts.json` file — `src/plugin/index.ts`. See [initialization and offline migration](docs/MIGRATION.md).

**Session Recovery:**
1. `session.error` event fires — `src/plugin/event-handler.ts`
2. `isRecoverableError()` checks error type — `src/plugin/recovery/`
3. `handleSessionRecovery()` injects synthetic `tool_result` blocks — `src/plugin/recovery/`
4. If `auto_resume`, plugin sends a "continue" prompt via `client.session.prompt()` — `src/plugin/event-handler.ts`

**Quota Tracking & Refresh Flow:**
1. Background refresh or user-triggered update invokes quota management — `src/plugin/fetch-interceptor.ts`, `src/plugin/oauth-methods.ts`
2. Core fetches Antigravity's `retrieveUserQuotaSummary`, with endpoint fallback; if that fails, it falls back to `fetchAvailableModels()` — `packages/core/src/quota-manager.ts`, via `src/plugin/quota.ts`
3. Quota responses map to group/window and per-model readings for the account — `src/plugin/quota.ts`
4. Active storage persists the updated summaries — `src/plugin/storage.ts`
5. The terminal UI `showAuthMenu()` displays the status, treating stale cache values (0% remaining without a future reset time or reset time in the past) as `READY` (fail-open) and displaying paywalled Pro models as `(unavailable)` — `src/plugin/ui/auth-menu.ts`, `src/plugin/ui/quota-status.ts`

---

## Key Abstractions

**`AccountManager`:**
- Purpose: Single source of truth for all OAuth accounts, their cooldowns, health scores, quota caches, fingerprints, and daily/session request metrics
- Location: `src/plugin/accounts.ts`
- Pattern: Stateful class with selection algorithms (`sticky`, `round-robin`, `hybrid`) delegating to `HealthScoreTracker` and `TokenBucketTracker`; tracks in-memory session stats and persists daily request counters on disk

**`AntigravityConfig` / `AntigravityConfigSchema`:**
- Purpose: Zod-validated runtime configuration with environment variable overrides
- Location: `src/plugin/config/schema.ts`, `src/plugin/config/loader.ts`
- Pattern: Zod schema → `z.infer<>` type, merged from project file + user file + env vars

**`ResolvedModel`:**
- Purpose: Carry the Antigravity wire model and resolved thinking/search configuration, not a choice of provider request path
- Location: `src/plugin/transform/types.ts`, re-exported from core's `transform/types.ts`
- Pattern: Resolution result with `actualModel` and optional thinking level/budget, tier, image-model flags, config source, and Google Search settings. Request preparation reports `headerStyle: 'antigravity'` as fixed metadata; legacy sidebar `gemini-cli` values normalize to `antigravity` and cannot select a request path. See the [sidebar contract](docs/sidebar-contract.md).

**`ModelFamily`:**
- Purpose: Route model-specific logic (`claude` vs `gemini`)
- Location: `src/plugin/storage.ts` (type), `src/plugin/transform/model-resolver.ts`
- Pattern: Discriminated string union used by `AccountManager`, `quota.ts`, and rate-limit key construction

**`ModelQuotaGroup`:**
- Purpose: Partition available models into four quota tracking groups (`claude`, `gemini-pro`, `gemini-flash`, and `gpt-oss`)
- Location: `src/plugin/model-registry.ts` (type), `src/plugin/quota.ts` (tracking)
- Pattern: String literal union mapping physical model IDs to logical quota partitions for aggregated reporting and per-model status

**`AuthDoctor`:**
- Purpose: Diagnose and self-heal storage inconsistencies and active credentials drift
- Location: `src/plugin/auth-doctor.ts`, `src/plugin/auth-drift.ts`
- Pattern: Diagnostic functional reporting (`createAuthDoctorReport`) that identifies severity findings and suggests/applies target repairs (e.g., restoring active accounts, clamping indices)

**`SignatureStore` / `SignatureCache`:**
- Purpose: Cache Claude thinking-block signatures in memory and optionally on disk, keyed by session
- Location: `src/plugin/core/streaming/types.ts`, `src/plugin/cache/signature-cache.ts`, `src/plugin/stores/signature-store.ts`
- Pattern: Map-based store with TTL; disk layer uses JSON file with background flush interval

---

## Entry Points

**Plugin Factory:**
- Location: `src/plugin/index.ts` → `createAntigravityPlugin(providerId)`
- Triggers: OpenCode loads package `index.ts`, which exports the initialized plugin aliases
- Responsibilities: Initialize all subsystems, register auth methods, and return the OpenCode hook surface

**Root Index:**
- Location: `index.ts`
- Triggers: OpenCode plugin host imports the package
- Responsibilities: Export only `AntigravityCLIOAuthPlugin` and `GoogleOAuthPlugin`

**Auto-Update Hook:**
- Location: `src/hooks/auto-update-checker/index.ts`
- Triggers: `session.created` event
- Responsibilities: Compare current vs latest npm version; update `opencode.json` pin if auto-update enabled

---

## Error Handling

**Strategy:** Defensive try/catch with graceful degradation — fallback values rather than crashes. Rate-limit and quota errors trigger account rotation, not failure. Session errors trigger recovery injection. Empty responses retry up to `empty_response_max_attempts` times before returning a synthetic error response. Token refresh failures throw typed `AntigravityTokenRefreshError`. Unknown errors are caught, logged, and surfaced as domain errors to callers. Capacity rate-limits (503/429) trigger a device fingerprint regeneration after 1 attempt per endpoint fallback.

---

## Cross-Cutting Concerns

**Logging:** `createLogger("module-name")` from `src/plugin/logger.ts` for structured per-module logging with dual sinks: TUI log panel (`debug_tui`) and debug file (`debug`). Per-message API request counters track request volumes for diagnostic visibility. Post-request logging outputs cached remaining quota percentages, session request rates (average requests per hour), and cache hit/miss statistics (HIT, MISS, WRITE status and hit rate percentage) computed from response usage metadata. `console.log` only in CLI / interactive auth flows.

**Caching:** In-memory signature store for thinking blocks; optional disk persistence via `SignatureCache` when `keep_thinking` is enabled. Auth tokens cached per-account in `AccountManager`. Quota data cached per-account with configurable TTL and background refresh. Prompt caching utilizes a strict prefix-stabilization ordering (stable system instructions first, dynamic content last) to maximize gateway-level cache hits.

**Storage:** Local accounts use the active shared-store generation selected by a pointer beside the resolved legacy account path. Legacy `antigravity-accounts.json` is offline migration input or successful rollback output, not the active writer target. Keep the pointer, generations, and protected migration files owner-only. Do not recreate the legacy file to bypass initialization or offline migration; rollback also refuses an existing/recreated legacy file. See [migration and rollback](docs/MIGRATION.md). Config loads from `.opencode/antigravity.json` (project) and the user configuration directory.

**Configuration:** Two-level config file hierarchy (project overrides user) plus environment variable overrides. All config is read once at startup via `loadConfig()` and made available globally via `initRuntimeConfig()` and module-level getters. Active controls include `max_account_switches: 2` and `thinking_warmup: false`; old `cli_first`, `quota_fallback`, `quota_style_fallback`, and `operator.routing` settings are ignored. See [Antigravity routing](docs/MULTI-ACCOUNT.md#antigravity-routing) for the consumer Gemini CLI retirement and its effect on these settings.
