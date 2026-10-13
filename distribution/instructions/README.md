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

Since 2.3.0, merge the **Parent model and effort selection** section when updating these templates. `auto` fields require a task-specific concrete selection and `selection_reason`. Discover supported settings with `agent_models`; keep fixed fields unchanged. Model/effort selection does not change the separate provider routing policy. The installer/updater does not modify existing global instruction files.

For 2.5.0, also merge **Background jobs, limits, and partial work** and **Managed parallel worktrees**. These explain complete review bodies with compact diagnostics, persistent worktree storage, explicit migration/recovery, checkout health and opt-in patch-equivalent cleanup. Preview migration/recovery first; both default to dry-run. Existing TEMP worktrees and provider sessions are not migrated automatically. PowerShell selection uses the bundled runtime or an explicit valid native PowerShell 7+ path, with no 5.1 fallback.

For 2.5.1, update the Windows storage default to `%USERPROFILE%/.agent-acp/worktrees` and merge the interrupted-job maintenance paragraph. The parent must review remaining workspace writers and provide `idle_confirmed=true` plus a summary for interrupted migration/recovery. This acknowledgement cannot override failed process checks and never marks the old job completed. Existing AppData/TEMP worktrees remain where they are until explicit migration.

For 2.5.2, merge the `agent_worktree_forget` guidance and the expanded interrupted cleanup rule. Forgetting only hides an absent worktree listing while retaining job evidence. Explicit interrupted cleanup now accepts idle confirmation after fresh process checks; nonempty work also requires verified integration. Automatic interrupted cleanup is still forbidden.

- Discover the actual `agent_*` tools and schemas. Do not infer tool availability from this file.
- The gateway detects the host from MCP client information. Never add a manual `MCP_HOST` override.
- Configure paths and provider policies in the host's MCP configuration, using the receiving machine's actual locations.
- Provider CLI installation and subscription login belong to the receiving user. Never distribute credentials or personal session/state folders.
- The templates do not authorize arbitrary external actions, publication, purchases, account changes, or destructive work.
- Missing telemetry is not task failure. Distinguish task results, provider eligibility, quota state, and display-only usage data.

## Verification scope

Use local fixture tests for an installation check that must avoid provider/model calls. Gateway `agent_status` and `agent_models` can initialize official CLI/ACP connections and query authentication, catalogs or billing, but do not send a task model prompt. Their compatibility checks do not certify successful model/tool execution.

The standalone monitor reads status separately and does not route model tasks. Global instructions cannot repair missing CLI installations, incorrect gateway paths, or unsupported runtime versions.


## Gateway 2.5.3 lifecycle and cleanup

Use agent_job_wait with timeout_seconds <= 25; legacy larger values are capped. A wait timeout/abort is not job cancellation. If the transport disconnects, query the same persisted job ID after reconnecting; do not replay it. A host may forcibly terminate the gateway despite drain handling. Inspect completion, processCleanup, childCleanedUp, partial output and handoff before starting replacement implementation. Never assume CPU inactivity when stallEvidence.cpuIdle is unavailable.

Failed/cancelled committed worktrees may be cleaned only after actual ancestry integration into original HEAD, verified=true, idle_confirmed=true, a factual verification_summary, and fresh idle checks. Patch equivalence does not apply to those failures. Preview first. Opt into remove_ignored_artifacts=true only for intended disposable Git-ignored files; review removedIgnoredPaths including partial failures. Modified/untracked files, links, nested repositories and unmerged commits stay protected. Prefer Gradle --no-daemon and retain the gateway-provided GRADLE_USER_HOME; report remaining processes instead of terminating unrelated processes.

## Gateway 2.6.0 cleanup evidence and Gradle caches

Treat `processCleanupState` as `verified`, `remaining`, or `unverified`. A completed provider turn with unverified cleanup and no observed remaining PID stays successful with a warning; inspect `processCleanupWarning` and `handoff`. Do not automatically launch a replacement implementation or delete its worktree. Later implementation providers may be skipped for parent review.

For a finished job whose cleanup was unverified, supply `idle_confirmed=true` and a factual `verification_summary`, then let the gateway freshly check every tracked PID and workspace ownership. Live, inaccessible, or unknown process evidence still blocks cleanup/forget. Existing integration, verification and dirty-file checks remain mandatory. A historical failed outcome is not rewritten. Linux uses the same rules; restricted /proc information can prevent confirmation.

All providers reuse the existing Gradle home/cache. Use `--no-daemon`, preserve `GRADLE_USER_HOME`, and do not delete build artifacts or run clean just to tidy the worktree. Parent can use `remove_ignored_artifacts=true` after integration review. A missing Wrapper distribution may download even with `--offline`; report missing cache entries and obtain user authorization before downloading. Report observed download targets. Absence of download telemetry is not proof of no network activity. Shared user caches and old task Gradle homes must not be deleted automatically.

Linux and WSL use the same signed Gateway package and `agent-acp update`; the Monitor is a Windows component. Preserve the configured external state directory when upgrading. Never update or restart while an active job has not finished, and never copy authentication across operating systems.
