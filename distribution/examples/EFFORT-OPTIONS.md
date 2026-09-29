# Effort choices (checked 2026-09-28)

Change CLAUDE_EFFORT / CODEX_EFFORT in the MCP server env block, then reconnect MCP. These settings affect the delegated CLI, not the parent desktop model. Keep values as strings. `auto` means this gateway omits the effort argument so CLI/model defaults apply; it is not a reasoning level forwarded to a provider.

- Claude: `auto`, `low`, `medium`, `high`, `xhigh`, `max`. Confirmed by the installed `claude --help`; selected model/version may support only a subset.
- Codex: `auto`; official configuration reference gives model/client-advertised examples `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. This is not a promise that every model supports every value. Use the selected model's supported levels.
- No account API keys or CLI updates are needed to edit these settings.

Codex TOML supports # comments. The Claude .json example remains valid JSON; the matching .jsonc adds explanatory comments and is for reading/editing, not direct copying into a strict JSON config. Remove comments or use the .json when deploying. Persistent self-provider default: set env `ALLOW_SELF_PROVIDER` to string "true" or "false". Optional tool-call `allow_self_provider` boolean overrides it; omitted calls inherit the env default.

Sources: [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#model_reasoning_effort); installed Claude CLI `claude --help` (`--effort`).


Per-call overrides: model/effort for one explicit provider; provider_options for auto/multiple providers. See ../gateway/MODEL-OVERRIDES.md. These are tool-call arguments, not additional env keys. Specified fields override the configured defaults without changing configuration files.

