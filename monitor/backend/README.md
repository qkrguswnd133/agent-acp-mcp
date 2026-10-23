# Agent Monitor read-only backend

Run `node backend/worker.mjs`. Keep this subprocess alive across UI refreshes to use the existing billing/status TTLs. Send one JSON object per line:

```json
{"id":1,"method":"status"}
```

Replies are `{"id":1,"result":{...}}` or `{"id":1,"error":"status_unavailable"}`. Concurrent status requests share one in-flight collection. Only `status` is supported. Default refresh interval should be 60 seconds; do not start overlapping workers for polling. Close/terminate only the monitor worker's process tree; never terminate gateway processes. Worker EOF exits the worker. CLI helpers are read-only but may still be completing when EOF arrives, so shell shutdown should terminate this worker's own descendants too.

## Paths and configuration

- `AGENT_GATEWAY_ROOT` overrides `%USERPROFILE%/.codex/tools/agent-acp-mcp`.
- Read allowlisted scalar values from `%CODEX_HOME%/config.toml` (default `%USERPROFILE%/.codex/config.toml`), exact `[mcp_servers.agent.env]` table. Existing process environment wins.
- Allowed: provider `ENABLED`, `CLI`, `MODEL`, `EFFORT`, `SPEED`, `CODEX_CLI_PATH`, `QUOTA_RETRY_MINUTES`, `AGENT_MCP_STATE_DIR`, `AGENT_MCP_WORKTREE_DIR`, `AGENT_MCP_AUTO_CLEAN_IGNORED_ARTIFACTS`, `CODEX_POWERSHELL_PATH`.
- No API keys, tokens or MCP host overrides are copied or returned.
- Use an ordinary system Node executable. Compiled gateway modules and its dependencies must be present.

## Result schema

`generatedAt`: ISO timestamp when collection finished.

`providers`: array in `grok`, `claude`, `codex` order:

- `provider`, `enabled`; `available`, `authenticated`, `subscriptionAuth` are booleans or `"unknown"`.
- `version`, `versionSource`; Grok version is explicitly `last_known_health`, never a new health check.
- `model`, `effort`: last observed value or null. `modelSource`/`effortSource`: `last_known_health`, `last_known_job` or `unavailable`. Configured policy is separate in `modelPolicy`/`effortPolicy`; never show `auto` as an observed model/effort.
- `observedAt`: provider metadata observation timestamp. Null means unavailable.
- `lastRun`: `{jobId, at, status, model, effort, sessionId, turnId, selection, observation, executionSpeed}` from one newest settled result for this provider, or a newer active run with selection, observation or speed metadata. All fields belong to that same result. `at` uses the job's finish, last activity or start timestamp, in that order. Null means no eligible result exists. A legacy or unknown latest result still returns the object with null fields, so the detail view cannot inherit older model, effort or speed evidence.
- `lastRun.selection.model|effort` is `{value, source:'parent'|'configured', reason}` and is never an actual value; `lastRun.observation.model|effort` is `{value, source, verified}`. Either side or axis may be null. Direct `lastRun.model`/`effort` preserve observed legacy result values independently of selection.
- `lastRun.executionSpeed`: null when absent, otherwise exactly `{requested, settingSource, observed, observationSource, verified, effective, effectiveSource, effectiveVerified, threadId, turnId}`. Speed values allow only `standard`, `fast`, `ultrafast`; unknown values are null. `settingSource` allows `configured` or `default`. Source strings are bounded safe identifiers and may include `/`, preserving sources such as `app_server.thread/start`.
- Speed `verified` requires a valid `observed` value and an explicit true flag. `effectiveVerified` additionally requires Codex, valid `effective`, an explicit true flag, speed IDs matching the result's nonempty `sessionId` and `turnId`, and one of `app_server.thread/start`, `app_server.thread/resume`, `app_server.thread/settings/updated`. `effective` means the CLI-applied setting for that task; it is separate from backend observation. Requests, other providers and unmatched IDs cannot certify application. Unverified reported values remain labeled as such by the UI.
- `quota`: `state` (`available`, `exhausted`, `unknown`), `source`, numeric-or-null `usedPercent`/`remainingPercent`, ISO-or-null `resetsAt`/`retryAfter`/`observedAt`, nullable `limitKind`, boolean `stale`.
- `reason`: generic safe reason or null. No raw upstream errors.
- No `host`, `selfProvider`, or `callable`: this standalone monitor does not route provider requests.

**Stale Grok values can remain numeric but must always display as last-known/stale**, never a current balance. Missing numeric values are null, not zero. Claude and Codex window labels in the bar come only from observed quota window records; missing windows are not invented.

`jobs`: up to 20 newest gateway job summaries. Fields: `jobId`, stored `status`, `project` (cwd basename), `cwd`, `startedAt`, `lastActivityAt`, `finishedAt`; `providers` contains `provider`, observed `model`/`effort`, sanitized `selection`/`observation` (null when absent), `sessionId`, `turnId`, the same allowlisted `executionSpeed`, numeric allowlisted `usage`, `status`, `errorKind`. Stored running status is not proof the owner process is still alive. No prompts, task instructions, partial responses, raw stdout, raw errors, speed warnings/notes/reasons, `cliAppliedSettings`, credentials or full result objects are returned.

## Side effects

No gateway entrypoint, Grok provider, health module or JobManager is constructed. Grok imports only billing and sends official initialize/authenticate/billing requests without `session/new` or model prompts. Claude/Codex imports only their provider classes and calls `.status(false)` (version/auth/official quota reads); never `.run()` or `.update()`. Their existing quota cache may briefly acquire a read lock; the monitor itself never rewrites gateway job or quota state. All provider failures are isolated.

Tests use temporary files and injected fixture adapters/billing functions; no model requests or subscription consumption.
