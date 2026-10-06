# Managed worktrees for parallel implementation

`agent_implement` accepts:

- `workspace_mode: auto` (default): use the original cwd unless an active overlapping job blocks implementation; then create a separate worktree.
- `workspace_mode: current`: preserve the previous conflict error, with no automatic worktree.
- `workspace_mode: isolated`: always create a worktree, useful for independent parallel implementations.
- `base_ref`: a committed starting ref. Required when the original repository contains uncommitted changes. Those changes are never copied, committed, stashed or reset automatically. Parent must decide whether the selected commit contains the prerequisites for this task.

Git must be available and the source must have a commit. On Windows, new worktrees are created under `%LOCALAPPDATA%\Agent ACP MCP\worktrees\<job UUID>\<original repository name>` on branch `agent-acp/<job UUID>`. Set `AGENT_MCP_WORKTREE_DIR` to an absolute path to choose another persistent root. Git history is shared; checkout files and generated dependencies occupy additional space. Hooks are disabled for gateway Git maintenance. Dependencies are not installed automatically.

Existing worktrees under the OS temporary directory's `agent-acp-worktrees` remain registered at their original locations. Updating or changing the environment variable does not migrate them. TEMP cleanup schedules vary by PC policy; there is no guaranteed safe retention period.

The returned job includes `worktree` metadata with original cwd, repository, isolated path, branch, base commit, and whether original changes were omitted. Absolute/relative allowed paths are mapped into the new checkout. The original cwd is retained for parent reporting; provider session telemetry uses the actual isolated cwd, so external usage collectors may display the worktree name.

## Parent lifecycle

1. Use `agent_job_wait(job_id, timeout_seconds=25)` or `agent_job_status` until terminal. Cancelling a wait or reaching its timeout does not cancel the job. Clean empty worktrees (`tip == base`, no modified/untracked/ignored files) are removed after successful, failed or cancelled jobs. Partial changes and commits remain preserved.
2. Call `agent_worktree_status(job_id)` to inspect branch, base, changes and checkout health. `commitEmpty` means only `tip == base`; `cleanEmpty` additionally requires an intact checkout and no modified, untracked or ignored files. Do not treat `commitEmpty` alone as safe to delete.
3. Review the diff, run appropriate verification, and commit intended changes in the isolated worktree. Integrate them into the original checkout and test the integrated result. Do not merge while another agent is changing the original checkout.
4. Remove only reviewed disposable build artifacts in the isolated tree. Modified, untracked **and ignored** files prevent automatic removal.
5. Call `agent_worktree_cleanup(job_id, integration_ref="HEAD", verified=true, verification_summary="<checks and results>")`.

For nonempty worktrees, cleanup checks successful completion, parent verification, no known active jobs in either workspace, correct managed path/branch/Git registration, a complete clean isolated checkout, and its HEAD being an ancestor of the current original HEAD identified by `integration_ref`. Original modified/untracked files do not block removal and are untouched. Clean empty worktrees bypass integration/verification and original-workspace activity checks; activity in the target still blocks deletion. Interrupted jobs and known incomplete child-process cleanup remain preserved. Ordinary Git removal never uses force; branch deletion uses the verified tip as a compare-and-swap guard. There is no automatic merge, scheduled cleanup or automatic re-execution.

For cherry-picked changes, `allow_patch_equivalent=true` optionally permits an additional verification route; its default is `false`. Every source commit must already be an ancestor or have an equivalent patch in the **current** original HEAD, and the current trees must match on every path touched by any source commit. A historical match followed by a revert or later edit is insufficient. Merge/root commits and incomplete patch coverage are refused. Squashes are not assumed equivalent. Parent verification remains required for apply, and patch-equivalent dry runs also require a factual `verification_summary`. Use `integration_ref="HEAD"` for the original checkout you actually tested; the gateway does not merge or run those tests for you.

## Inventory and bulk cleanup

`agent_worktree_list(offset=0, limit=50, include_removed=false, include_disk_size=false)` returns job IDs/states, base/tip, commit and changed-file counts, checkout health, integration into original HEAD and creation time. Inspections use at most four concurrent workers. Disk size is omitted by default; request `include_disk_size=true` when needed. Disk scanning stops after two seconds or 10,000 entries per tree, never follows directory junctions, and marks incomplete estimates. Historical creation times fall back to the job start. `agent_status.worktreeWarnings` highlights records older than 3 days (cached for one minute), including a reminder that TEMP cleanup timing varies.

Preview with `agent_worktree_cleanup(job_ids=[...], dry_run=true)`. Apply the same list with `dry_run=false`; nonempty targets additionally require `verified=true` and a factual `verification_summary`. Each target has its own success or skip reason; one blocked target does not stop the rest. A single `job_id` remains supported. Up to 50 IDs may be supplied per call. Previously retained empty worktrees can be cleaned this way; an update does not sweep existing folders automatically.

## Explicit migration and recovery

Preview an intact worktree move with `agent_worktree_migrate(job_id, dry_run=true, target_root="<absolute root>")`. `dry_run` defaults to `true`; `target_root` is optional and defaults to the currently configured persistent root. Apply with `dry_run=false` only after the job and both workspaces are idle. The tool verifies registration and checkout health, refuses destination collisions, and moves with Git while preserving the managed branch. It updates the stored job cwd. `restartRequired=true` means the provider session must be restarted at the new cwd; existing session transcripts are not rewritten. An update never runs this migration automatically.

`checkoutState` distinguishes `complete`, `partial`, `git-metadata-only` and `missing`. A missing path preserves its branch and registration for inspection. Partial checkouts and missing paths are refused by ordinary cleanup and migration. An empty commit range does not establish an intact checkout.

`agent_worktree_recover(job_id, action="restore", dry_run=true)` is narrowly scoped to a **git-metadata-only** checkout where every tracked file is gone. The default action is `restore`, and the default is a dry run. Recovery refuses staged changes, sparse checkouts, partial loss and unknown checkout state. Apply requires an idle job/workspaces, `dry_run=false`, `verified=true` and a `verification_summary` acknowledging the missing files and the chosen action. `restore` materializes tracked files from the preserved HEAD; it cannot recover uncommitted file contents that were already deleted. `action="remove"` removes the damaged checkout registration but **preserves its branch**. Inspect that branch before deciding how to integrate or discard it separately.

## Complete review bodies and compact diagnostics

`agent_job_status` and `agent_job_wait` preserve complete `result.text` and every `result.results[*].text`. Command output, raw events and other ancillary text are compacted first, using Unicode-safe head/tail previews, truncation counts and artifact metadata. Ordinary responses target 64 KiB. If preserving the result bodies exceeds that budget, `payload.responseLimitExceededByReview` is `true`; `contentBytes` measures their combined UTF-8 text and `serializedContentBytes` accounts for JSON escaping. This exception applies to result bodies, not arbitrary fields named `text`.

Full snapshots (including Codex JSONL stdout and command output) are stored under `state/jobs/<job_id>/artifacts/`; artifact references include relative path, byte size and SHA-256. `verbose=true` restores the full original diagnostics and may exceed the caller's output limit. Legacy inline records remain readable. Storage/hydration errors preserve the original task outcome and add diagnostics; artifacts above 128 MiB remain inline on disk with a diagnostic. Settings/state backups preserve this directory during updates. The caller may impose its own display limits even when the gateway returns the complete review.

`merge`/fast-forward integration uses automatic ancestry verification. The optional patch-equivalent route uses the stricter checks described above. Verification is the parent's assertion and evidence; Git checks do not substitute for tests.

The gateway does not merge or commit for the parent. Start-time conflict detection remains process-local. Cleanup also checks live jobs in shared job storage, but cannot lock unrelated editors or Git commands. Keep those inactive during cleanup. Source-only preparation errors preserve any created branch/worktree and identify the path rather than force removing it.

Reconnect MCP after active work finishes to load the new tools. The monitor binary is unchanged.


## Project attribution for Grok, Claude and Codex

The common Gateway worktree preparation preserves the real repository name, not a hardcoded project or a caller-supplied label. For example, two different repository roots become `<UUID>/sample-project` and `<UUID>/another-project`. A requested subdirectory stays the same relative subdirectory; its cwd basename therefore stays that subdirectory name. Pass the real project root as cwd when root-level project attribution is intended. The execution scope is never silently widened for accounting.

All three providers receive the actual isolated cwd. Original cwd metadata is used by Monitor to label the project and distinguish isolated work, with both paths in its tooltip. No provider transcript cwd is forged or rewritten. A cwd-based usage collector derives project names from official Claude JSONL cwd, so preserving the folder name fixes new Claude worktree attribution without altering the collector or adding an ignored project_name argument. Other corporate collectors must be checked separately.

Existing worktrees are not automatically renamed or migrated; legacy sessions retain their old cwd until the parent explicitly migrates the checkout and restarts the provider session. Cleanup remains compatible with the old UUID-only layout. Previously collected corporate rows and historical official sessions are not rewritten. Reconnect MCP to load the updated Gateway before starting new work.
