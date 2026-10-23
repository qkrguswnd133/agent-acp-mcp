# Delegated agent execution speed

Available in release 2.7.2 / Gateway 2.7.1, with Monitor 1.4.1 environment forwarding. Windows and Linux/WSL use the same configuration keys.

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

Results include `executionSpeed.requested` and `executionSpeed.settingSource`. `executionSpeed.observed` is populated only from structured provider output (`usage.speed` or the Codex completed-turn service tier), otherwise `unavailable`. A configuration request is not proof of actual server processing speed. Claude's final `fastModeState` and `fastModeDisabledReason` are retained separately; `off` or `cooldown` does not describe every request in a session. A reported mismatch adds a warning without retrying or discarding the task result.

Official references checked on 2026-10-23:

- [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Fast mode](https://code.claude.com/docs/en/fast-mode)
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)

Local compatibility checks used Codex CLI 0.163.0 (model discovery and ephemeral thread configuration only), Claude Code 2.1.308 control initialization, and Grok Build 1.0.30 help/ACP documentation. No paid Fast/Ultrafast model prompt is required by regression tests.
