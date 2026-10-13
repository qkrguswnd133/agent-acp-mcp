# Job completion, waiting and cleanup (2.5.3)

## Claude, Grok and Codex completion and cancellation

`turn.completed` is detected while reading the CLI stream, rather than after process exit. A short grace period allows normal CLI teardown; the gateway then stops the owned process if it remains running. Text, usage, model/effort observations and command evidence survive an abnormal teardown. A matching session ID, cwd and execution time are required before `task_complete` in the official session JSONL can supplement missing terminal output. An ordinary final-looking agent message alone never proves completion.

Claude uses its official top-level JSON `type: "result"` envelope, including when emitted without a final newline. It keeps JSON mode, the generated session ID and official project-attributed JSONL. Error envelopes remain failures even when the process is stopped deliberately after receiving them. Direct result metadata and partial session text survive cancellation/deadline errors.

Grok uses the ACP `session/prompt` response and requires `stopReason: "end_turn"` for success. Its cancellation acknowledgement grace is five seconds; an unresponsive request then yields to forced cleanup. ACP child and terminal cleanup are bounded, and billing/session-usage observations have independent eight-second limits. Unavailable usage never replaces the original task result. All three providers report observed completion and process cleanup separately.

Cancellation and runtime deadlines use bounded process cleanup rather than waiting indefinitely for `close`. Results expose `completion`, `processCleanup`, and `childCleanedUp`. CLI/terminal stop paths allow up to approximately 14 seconds for root and descendant cleanup, plus Grok's cancellation grace and telemetry windows where applicable; slow disks or OS process inventory can still delay reporting. A confirmed turn is not proof that the user's implementation criteria passed. Inspect errors, command exits and the worktree. Unconfirmed child cleanup stops subsequent implementation providers and returns parent handoff information.

`stalled_suspected` uses `lastActivityAt` even when a different gateway owns the job. `stallEvidence` reports idle time, threshold and observed terminal signal. CPU idleness is `unavailable` unless actually measured. No stall warning automatically cancels or reruns a job.

## Waiting and transport lifetime

Use `agent_job_wait(job_id, timeout_seconds=25)`. Legacy values through 60 remain accepted, but the actual wait is capped at 25 seconds; `wait.effective_timeout_seconds` reports the cap. Set the host request deadline above this, allowing time for status serialization. Reissue on `wait.timed_out`; aborting the wait does not abort the job.

If the host closes stdin or breaks stdout, accepted work drains under its original runtime deadline and writes its result to disk. A new gateway sharing the installation can query it. Explicit `agent_job_cancel` and OS termination signals still cancel. A host that forcibly terminates the gateway process cannot be prevented from interrupting work. No automatic replay, scheduling or resumed implementation is performed.

Completion push notifications are not enabled: client subscription support and delivery across reconnects are not consistently available. Persisted status plus short bounded waits remain the source of truth; a notification would not replace them.

## Reviewed failed/cancelled worktrees

Preview with `agent_worktree_cleanup(job_id, dry_run=true)`. A failed/cancelled job with commits can be removed only after its tip is an ancestor of the original repository's current HEAD, and the parent supplies `verified=true`, `idle_confirmed=true`, and `verification_summary`. Patch equivalence cannot substitute for ancestry for these failed/cancelled jobs. A fresh Windows process inventory rejects observable workspace writers and unknown provider ownership; the gateway may remain alive serving unrelated work. Active jobs, incomplete child cleanup, dirty targets and unmerged commits remain blocked. Job outcome, logs and usage are not rewritten as successful.

Add `remove_ignored_artifacts=true` only when the parent intends to discard ignored generated files. Eligibility and integration checks precede deletion. Dry-run returns `ignoredArtifactPaths`; apply returns and persists `removedIgnoredPaths`, including partial deletion if a locked file prevents completion. Only Git-ignored, untracked regular files and empty ignored parent directories are removed. Tracked modifications, ordinary untracked files, links/junctions and nested repositories are refused. No recursive or forced worktree deletion is used. Keep manual writers inactive during cleanup; filesystem changes by unrelated applications cannot be atomically locked by this gateway.

## Build processes

Claude, Grok and Codex implementation receive a unique `GRADLE_USER_HOME` beneath gateway state and their prompts recommend `--no-daemon`. Grok also propagates that home to ACP terminal tools, whose cleanup evidence is recorded with command results. Caches are retained for inspection, not recursively deleted. Captured descendant PIDs are checked against their creation identity before termination. Already detached children missed between snapshots cannot always be attributed safely; unrelated Java/Node processes are never killed merely for sharing a cwd. Inspect `processCleanup.remainingPids`, `verified` and `note` before manual intervention. An unknown cleanup result blocks automatic worktree cleanup.

Install using the signed 2.5.3 release and the existing Monitor updater or ZIP `Update.ps1`. Finish active work before replacement, preserve state, and reconnect MCP. No provider CLI, authentication scheme, self-provider default, or model policy is changed.
