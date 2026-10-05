# Managed worktrees for parallel implementation

`agent_implement` accepts:

- `workspace_mode: auto` (default): use the original cwd unless an active overlapping job blocks implementation; then create a separate worktree.
- `workspace_mode: current`: preserve the previous conflict error, with no automatic worktree.
- `workspace_mode: isolated`: always create a worktree, useful for independent parallel implementations.
- `base_ref`: a committed starting ref. Required when the original repository contains uncommitted changes. Those changes are never copied, committed, stashed or reset automatically. Parent must decide whether the selected commit contains the prerequisites for this task.

Git must be available and the source must have a commit. Worktrees are created under the OS temporary directory's `agent-acp-worktrees/<job UUID>/<original repository name>` folder on branch `agent-acp/<job UUID>`. Git history is shared; checkout files and generated dependencies occupy additional space. Hooks are disabled for gateway Git maintenance. Dependencies are not installed automatically. Do not use this temporary directory as permanent storage.

The returned job includes `worktree` metadata with original cwd, repository, isolated path, branch, base commit, and whether original changes were omitted. Absolute/relative allowed paths are mapped into the new checkout. The original cwd is retained for parent reporting; provider session telemetry uses the actual isolated cwd, so external usage collectors may display the worktree name.

## Parent lifecycle

1. Use `agent_job_wait(job_id, timeout_seconds=25)` or `agent_job_status` until terminal. Cancelling a wait or reaching its timeout does not cancel the job. Clean empty worktrees (`tip == base`, no modified/untracked/ignored files) are removed after successful, failed or cancelled jobs. Partial changes and commits remain preserved.
2. Call `agent_worktree_status(job_id)` to inspect branch, base and changes.
3. Review the diff, run appropriate verification, and commit intended changes in the isolated worktree. Integrate them into the original checkout and test the integrated result. Do not merge while another agent is changing the original checkout.
4. Remove only reviewed disposable build artifacts in the isolated tree. Modified, untracked **and ignored** files prevent automatic removal.
5. Call `agent_worktree_cleanup(job_id, integration_ref="HEAD", verified=true, verification_summary="<checks and results>")`.

For nonempty worktrees, cleanup checks successful completion, parent verification, no known active jobs in either workspace, correct managed path/branch/Git registration, a clean isolated checkout, and its HEAD being an ancestor of the current original HEAD identified by `integration_ref`. Original modified/untracked files do not block removal and are untouched. Clean empty worktrees bypass integration/verification and original-workspace activity checks; activity in the target still blocks deletion. Interrupted jobs and known incomplete child-process cleanup remain preserved. Git removal never uses force; branch deletion uses the verified tip as a compare-and-swap guard. There is no automatic merge, scheduled cleanup or automatic re-execution.

## Inventory and bulk cleanup

`agent_worktree_list(offset=0, limit=50, include_removed=false)` returns job IDs/states, base/tip, commit and changed-file counts, integration into original HEAD, creation time and disk size. Disk scanning stops after two seconds or 10,000 entries per tree, never follows directory junctions, and marks incomplete estimates. Missing paths are reported without deleting their branches. Historical creation times fall back to the job start. `agent_status.worktreeWarnings` highlights records older than 14 days (cached for one minute).

Preview with `agent_worktree_cleanup(job_ids=[...], dry_run=true)`. Apply the same list with `dry_run=false`; nonempty targets additionally require `verified=true` and a factual `verification_summary`. Each target has its own success or skip reason; one blocked target does not stop the rest. A single `job_id` remains supported. Up to 50 IDs may be supplied per call. Previously retained empty worktrees can be cleaned this way; an update does not sweep existing folders automatically.

## Bounded job results

`agent_job_status` and `agent_job_wait` return compact results by default, with UTF-8 head/tail previews, truncation counts and artifact metadata. Full snapshots (including Codex JSONL stdout and command output) are stored under `state/jobs/<job_id>/artifacts/`; artifact references include relative path, byte size and SHA-256. `verbose=true` restores the full original result and may exceed the caller's output limit. Legacy inline records remain readable. Storage/hydration errors preserve the original task outcome and add diagnostics; artifacts above 128 MiB remain inline on disk with a diagnostic. Settings/state backups preserve this directory during updates.

`merge`/fast-forward integration is supported for automatic ancestry verification. Cherry-pick/squash integration does not generally preserve ancestry and requires manual equivalence review and manual cleanup; the gateway will not guess that changes are equivalent. Verification is the parent's assertion and evidence; Git checks do not substitute for tests.

The gateway does not merge or commit for the parent. Start-time conflict detection remains process-local. Cleanup also checks live jobs in shared job storage, but cannot lock unrelated editors or Git commands. Keep those inactive during cleanup. Source-only preparation errors preserve any created branch/worktree and identify the path rather than force removing it.

Reconnect MCP after active work finishes to load the new tools. The monitor binary is unchanged.


## Project attribution for Grok, Claude and Codex

The common Gateway worktree preparation preserves the real repository name, not a hardcoded project or a caller-supplied label. For example, two different repository roots become `<UUID>/sample-project` and `<UUID>/another-project`. A requested subdirectory stays the same relative subdirectory; its cwd basename therefore stays that subdirectory name. Pass the real project root as cwd when root-level project attribution is intended. The execution scope is never silently widened for accounting.

All three providers receive the actual isolated cwd. Original cwd metadata is used by Monitor to label the project and distinguish isolated work, with both paths in its tooltip. No provider transcript cwd is forged or rewritten. A cwd-based usage collector derives project names from official Claude JSONL cwd, so preserving the folder name fixes new Claude worktree attribution without altering the collector or adding an ignored project_name argument. Other corporate collectors must be checked separately.

Existing worktrees are not renamed; resumed legacy sessions retain their old cwd. Cleanup remains compatible with the old UUID-only layout. Previously collected corporate rows and historical official sessions are not rewritten. Reconnect MCP to load the updated Gateway before starting new work.
