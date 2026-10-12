# Job completion, waiting and cleanup (2.5.3)

## Codex completion and cancellation

`turn.completed` is detected while reading the CLI stream, rather than after process exit. A short grace period allows normal CLI teardown; the gateway then stops the owned process if it remains running. Text, usage, model/effort observations and command evidence survive an abnormal teardown. A matching session ID, cwd and execution time are required before `task_complete` in the official session JSONL can supplement missing terminal output. An ordinary final-looking agent message alone never proves completion.

Cancellation and runtime deadlines use bounded process cleanup rather than waiting indefinitely for `close`. Results expose `completion`, `processCleanup`, and `childCleanedUp`. The runtime stop path allows up to approximately 14 seconds for root and descendant cleanup, followed by bounded local telemetry/persistence; slow disks or OS process inventory can still delay reporting. A confirmed turn is not proof that the user's implementation criteria passed. Inspect errors, command exits and the worktree.

`stalled_suspected` uses `lastActivityAt` even when a different gateway owns the job. `stallEvidence` reports idle time, threshold and observed terminal signal. CPU idleness is `unavailable` unless actually measured. No stall warning automatically cancels or reruns a job.

## Waiting and transport lifetime

Use `agent_job_wait(job_id, timeout_seconds=25)`. Legacy values through 60 remain accepted, but the actual wait is capped at 25 seconds; `wait.effective_timeout_seconds` reports the cap. Set the host request deadline above this, allowing time for status serialization. Reissue on `wait.timed_out`; aborting the wait does not abort the job.

If the host closes stdin or breaks stdout, accepted work drains under its original runtime deadline and writes its result to disk. A new gateway sharing the installation can query it. Explicit `agent_job_cancel` and OS termination signals still cancel. A host that forcibly terminates the gateway process cannot be prevented from interrupting work. No automatic replay, scheduling or resumed implementation is performed.

Completion push notifications are not enabled: client subscription support and delivery across reconnects are not consistently available. Persisted status plus short bounded waits remain the source of truth; a notification would not replace them.

## Reviewed failed/cancelled worktrees

Preview with `agent_worktree_cleanup(job_id, dry_run=true)`. A failed/cancelled job with commits can be removed only after its tip is an ancestor of the original repository's current HEAD, and the parent supplies `verified=true`, `idle_confirmed=true`, and `verification_summary`. Patch equivalence cannot substitute for ancestry for these failed/cancelled jobs. A fresh Windows process inventory rejects observable workspace writers and unknown provider ownership; the gateway may remain alive serving unrelated work. Active jobs, incomplete child cleanup, dirty targets and unmerged commits remain blocked. Job outcome, logs and usage are not rewritten as successful.

Add `remove_ignored_artifacts=true` only when the parent intends to discard ignored generated files. Eligibility and integration checks precede deletion. Dry-run returns `ignoredArtifactPaths`; apply returns and persists `removedIgnoredPaths`, including partial deletion if a locked file prevents completion. Only Git-ignored, untracked regular files and empty ignored parent directories are removed. Tracked modifications, ordinary untracked files, links/junctions and nested repositories are refused. No recursive or forced worktree deletion is used. Keep manual writers inactive during cleanup; filesystem changes by unrelated applications cannot be atomically locked by this gateway.

## Build processes

Codex implementation receives a unique `GRADLE_USER_HOME` beneath gateway state and the prompt recommends `--no-daemon`. Caches are retained for inspection, not recursively deleted. Captured descendant PIDs are checked against their creation identity before termination. Already detached children missed between snapshots cannot always be attributed safely; unrelated Java/Node processes are never killed merely for sharing a cwd. Inspect `processCleanup.remainingPids`, `verified` and `note` before manual intervention. An unknown cleanup result blocks automatic worktree cleanup.

Install using the signed 2.5.3 release and the existing Monitor updater or ZIP `Update.ps1`. Finish active work before replacement, preserve state, and reconnect MCP. No provider CLI, authentication scheme, self-provider default, or model policy is changed.
