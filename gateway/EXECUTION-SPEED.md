# Delegated agent execution speed

Available in release 2.8.0 / Gateway 2.8.0, with Monitor 1.4.1 environment forwarding. Windows and Linux/WSL use the same configuration keys.

Configure speed once in the Gateway's environment block, independently of model and reasoning effort. No speed argument or automatic speed selection is added to MCP calls. The default is **Standard** even when model/effort policies are `auto`.

```toml
CODEX_SPEED = "standard"
CLAUDE_SPEED = "standard"
GROK_SPEED = "standard"
```

Use the same string keys inside `env` in Claude's MCP JSON, Codex's `[mcp_servers.agent.env]`, or the monitor configuration examples. Reconnect MCP after changing Gateway settings. Existing host configuration and provider login files are never modified by this feature.

| Provider | Configuration | Behavior |
| --- | --- | --- |
| Codex | `standard`, `fast`, `ultrafast` | Nonstandard speeds must appear in the selected model's official `model/list` catalog. Standard explicitly passes `service_tier="standard"` and disables Fast selection; the CLI normalizes this to a null service tier. Fast/Ultrafast are explicit opt-ins and do not reduce reasoning effort. |
| Claude | `standard`, `fast` | Standard sets `fastMode:false` and `CLAUDE_CODE_DISABLE_FAST_MODE=1` in the child and inline settings. Fast requires that the selected model advertises `supportsFastMode:true`; no model substitution is performed. Account or organization restrictions still apply. |
| Grok | `standard` | Uses the native Grok default. Independent speed control has not been verified in the official CLI/ACP interface. Fast/Ultrafast requests are rejected rather than silently ignored. |

Empty or absent values use `standard`; case and surrounding whitespace are normalized. Invalid values and unsupported selections fail before provider execution. `agent_status`/`agent_models` return `speedPolicy`, and catalog models include advertised `speeds` and capability evidence.

## Usage and evidence

Codex Fast/Ultrafast can consume included usage faster; availability depends on the selected model and account. Claude Fast uses **usage credits rather than included subscription rate limits**. Enabling a nonstandard speed is an explicit configuration choice. The Gateway retains the official logged-in CLI path and never switches to API-key authentication.

Results include `executionSpeed.requested` and `executionSpeed.settingSource`. Codex work now runs through the official CLI's stdio **app-server**, using one `thread/start` and one `turn/start` for the same task. The returned `serviceTier` provides `executionSpeed.effective`, `effectiveSource`, and `effectiveVerified`, bound to that task's thread/turn identifiers. For example, `priority` means **Fast — CLI applied**. A present null tier confirms Standard only for this run's explicitly requested Standard; a missing field remains unavailable. No separate status probe is presented as evidence for a past task.

`executionSpeed.observed` and the existing `verified` field still require structured backend/provider result evidence, otherwise they remain `unavailable`/false. A verified CLI-applied setting is not proof of the backend tier used by every request. Parent reports should use `effectiveVerified` to distinguish known CLI settings from unavailable backend evidence. Model/effort likewise retain their evidence source; same-work session observations take precedence over the thread's acknowledged configuration. Claude's final `fastModeState` and `fastModeDisabledReason` are retained separately; `off` or `cooldown` does not describe every request in a session. A reported mismatch adds a warning without retrying or discarding the task result.

The Gateway preserves its existing sandbox selection, never-ask approval policy, UTF-8 shell, Gradle cache, cancellation/deadline and partial-result behavior. App-server does not support exec's `--ignore-user-config`: before starting a work thread, the Gateway reads the effective project configuration and disables every inherited MCP entry. Plugins, apps, hooks and recursive multi-agent tools are disabled for the delegated thread. This config response is not saved in task artifacts. If the protocol/config inspection is unsupported, the task fails before a turn rather than silently replaying implementation through exec. Personal configuration/authentication files are not rewritten.

Official references checked on 2026-10-24:

- [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Fast mode](https://code.claude.com/docs/en/fast-mode)
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)

Actual read-only task checks passed with **Windows Codex CLI 0.164.0 / Standard** and **Linux (WSL) Codex CLI 0.162.1 / Fast**, using gpt-6-luna / low. Each task returned its own matching thread/turn, CLI-applied tier, model/effort, usage and terminal completion. Native Windows tests also confirmed inherited MCP servers (including dotted names) are disabled before thread creation. Regression tests use mock protocol servers and do not spend subscription quota.

Developers can explicitly run `node tests/Smoke-Codex-App-Server.mjs --cli <absolute-cli-path> --speed standard --report <report-path>` after building. This opt-in test uses the existing subscription login for one short read-only model turn in a temporary workspace; it is not run by `npm test`. Use `--speed fast` only when that usage is intended. Existing provider CLIs are not automatically upgraded. If an older CLI cannot inspect configuration or start a work thread, update that CLI separately and retry only after reviewing any returned partial work. Claude/Grok execution transports are unchanged.
