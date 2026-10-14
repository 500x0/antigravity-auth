# AGY CLI 1.3.5 identity-free fixtures

These projections come from the official CLI capture on 2026-10-14. The capture
status, catalog and three Argon Low request/response records were supplied as
redacted evidence. No project, token, session, trajectory or cascade identity
values are retained. Field names and key order are retained where they describe
the wire contract, not the caller.

`server-model-catalog.json` projects the complete 29-route `fetchAvailableModels`
map and its advertised model-ID lists. Its SHA-256 identifies the redacted source
record. Compared with the historical 35-route 1.3.3 projection, it adds
`gemini-4-argon-low`, `gemini-4-argon-medium` and `gemini-4-argon-high`, and removes:

- `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-pro-agent`
- `gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-high`
- `gemini-3.7-flash-low`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-high`

The parent's zero-generation comparison, using the same served token and project,
reported this identical 29-route set under both 1.3.3 and 1.3.5 User-Agents. The
comparison record was not attached to this fixture's inputs; the routing ruling
uses that reported result. These routes
were withdrawn by Antigravity, not hidden by a client-version change. The 1.3.3
fixtures remain historical evidence; the 1.3.5 map governs current admission.
The adapter now uses the accepted 1.3.5 identity (`cl=998863838`).

`argon-model-metadata.json` retains all three Argon rows, including the per-model
quota readings. Argon requires **Google AI Ultra**. Medium is the CLI default.
The redacted quota-summary projection does not record an Argon bucket or retain
quota bucket data. We use the specific per-model `quotaInfo` readings rather
than assigning an unrelated Gemini summary reading to Argon; weekly pool
attribution remains **unverified**.

`native-argon-low.json` projects the three admitted Low generations. All returned
HTTP 200 with terminal STOP and a complete SSE frame separator. The native
output default was 65536; the guard forwarded a cap of 2048. LOW sends
`thinkingConfig: {includeThoughts: true, thinkingLevel: "LOW"}` with no budget,
and omits `toolConfig`. The file-read continuation retains the observed role and
part-key shape, not the file contents or signature values. Helper calls to
Gemini 3.5 Flash Lite were refused; the run spent its three-generation budget.

**Not verified:** MEDIUM/HIGH wire encodings (inferred from catalog efforts 2/3),
whether Argon accepts VALIDATED toolConfig, images, video, multi-step tool chains
and cross-model history. The adapter omits toolConfig for the entire Argon
family; only LOW omission is directly captured. Mocked tests are not live
validation. No further generation was performed for this change.

## Metadata comparison (no algorithm change)

For the exact captured contents shapes at the metadata boundary, before any
previous completed execution, OpenCode's default part count emits `"1"` for a
single user text part and `"3"` for user text → model functionCall+thoughtSignature
→ model functionResponse. Pi's CLI count emits `"1"` and `"4"` respectively.
Native Argon's `last_step_index` was `"0"` for the text shape and `"2"` for the
continuation shape. A session with `lastExecutionId` adds one
to the adapter values (OpenCode `"2"`/`"4"`, Pi `"2"`/`"5"`); merely reusing a
session does not. Pi does not mark a tool-use response as a completed execution.
Upstream conversion can add a trailing user `[Continue]` before metadata, so
these counts describe the supplied shapes, not every host's final continuation.

Adapter label keys are `last_step_index`, `model_enum` (when known),
`trajectory_id`, `used_claude`, `used_claude_conservative`,
`used_non_gemini_model`, and conditional `last_execution_id`. Native Argon has
`last_step_index`, `model_enum`, `trajectory_id`, `used_claude`,
`used_claude_conservative`, `used_non_gemini_model`, plus `cascade_id`,
`root_cascade_id` and `request_id`, but no `last_execution_id`. No step-index or
label algorithm was changed in this release.

## Public selector change

Before: `antigravity-claude-opus-5-5`, `antigravity-claude-sonnet-5-5`,
`antigravity-gemini-3.1-flash-image`, `antigravity-gemini-3.1-pro`,
`antigravity-gemini-3.5-flash`, `antigravity-gemini-3.6-flash`,
`antigravity-gemini-3.7-flash`, `antigravity-gemini-3.8-flash`,
`antigravity-gpt-oss-120b-medium` (9).

After: `antigravity-claude-opus-5-5`, `antigravity-claude-sonnet-5-5`,
`antigravity-gemini-3.1-flash-image`, `antigravity-gemini-3.5-flash`,
`antigravity-gemini-3.8-flash`, `antigravity-gemini-4-argon`,
`antigravity-gpt-oss-120b-medium` (7). Pi excludes the image-output selector in
both sets (8 → 6); OpenCode 1 and 2 use the complete shared public set. Gemini CLI
fallback names are unchanged and are not public Antigravity picker entries.
