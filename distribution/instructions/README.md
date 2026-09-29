# Optional global instruction templates

These templates are general-purpose starting points for users of the unified `agent-acp-mcp` gateway. They contain no account credentials, usernames, company policies, fixed model versions, or machine-specific executable paths.

| File | Intended host | Default global instruction location |
| --- | --- | --- |
| `AGENTS.md` | Codex | `%USERPROFILE%\.codex\AGENTS.md`; use the configured Codex home if customized |
| `CLAUDE.md` | Claude Code | `%USERPROFILE%\.claude\CLAUDE.md`; follow the client's documented location if customized |

A Claude Desktop MCP connection does not by itself guarantee that Claude Code's global instruction file is loaded. Put the relevant guidance in the instruction mechanism supported by the client you actually use. Do not change MCP client identity to make a template appear applicable.

## Install or merge

1. Install and register the gateway separately. These Markdown files do not install tools, authenticate providers, or configure MCP.
2. Choose the template for the host that will read it. Review its workflow choices, including the preference for a 60-minute implementation call. The current gateway's omitted-parameter default remains 120 minutes.
3. Back up an existing global instruction file before editing it.
4. If no global file exists, copy the chosen template to the applicable location. If one exists, merge the relevant sections into it; do not replace existing personal, repository, company, or security guidance wholesale.
5. Resolve overlapping or contradictory instructions explicitly. Keep one current delegation/routing policy rather than appending duplicate copies after each upgrade. Preserve unrelated instructions.
6. Open a new host session or use the client's documented reload mechanism, then verify that the intended instructions and MCP tools are loaded.

Distribution installers should leave live global instruction files untouched by default. Keep these templates alongside the release for an intentional copy/merge. A template update should not silently overwrite a user's edited policy.

## Configuration remains separate

- Discover the actual `agent_*` tools and schemas. Do not infer tool availability from this file.
- The gateway detects the host from MCP client information. Never add a manual `MCP_HOST` override.
- Configure paths and provider policies in the host's MCP configuration, using the receiving machine's actual locations.
- Provider CLI installation and subscription login belong to the receiving user. Never distribute credentials or personal session/state folders.
- The templates do not authorize arbitrary external actions, publication, purchases, account changes, or destructive work.
- Missing telemetry is not task failure. Distinguish task results, provider eligibility, quota state, and display-only usage data.

## Verification scope

Use local fixture tests for an installation check that must avoid provider/model calls. A fresh gateway `agent_status` can perform Grok compatibility verification, including a small model request when health state is absent or changed. It is not a guaranteed no-usage smoke test. Check the current implementation and user-authorized scope before running it.

The standalone monitor reads status separately and does not route model tasks. Global instructions cannot repair missing CLI installations, incorrect gateway paths, or unsupported runtime versions.

