# Worktree maintenance and progress — release 2.7.2

Gateway 2.7.1 has the same behavior on Windows and Linux/WSL. Existing jobs and
provider results are retained. Reconnect MCP after updating; installation does
not clean or migrate existing worktrees.

## Cleanup scope and process evidence

Physical maintenance checks the **target isolated worktree**, not every job or
preview server associated with its original repository. A conflicting live job
still blocks and reports its job ID, owner PID and observed liveness. This does
not allow concurrent edits to the target checkout.

A successful job whose historical child cleanup is `unverified` is rechecked at
cleanup time. Empty `remainingPids` alone is not proof: fresh process identities
and target-workspace references must pass. Interrupted jobs and reviewed failed
committed work still need the documented parent review and `idle_confirmed`.
Relevant processes with unknown identity remain blockers. Positively unrelated
unreadable processes can be reported as warnings; an unreadable command line
alone is not permission to delete. The Gateway does not terminate unrelated
processes or preview servers to make cleanup succeed.

## Integration and checkout-only removal

`integration_ref` can identify an ancestor of the current original HEAD. The
Gateway verifies ancestry and rechecks the observed HEAD before mutation.
Normal cleanup still requires integration of the worktree tip, or explicit
patch equivalence with matching current content.

If reviewed integration intentionally changed the patch, use
`preserve_branch=true` with `verified=true` and a factual
`verification_summary`. This removes only an idle clean checkout, retaining its
branch, commits and job record. It does **not** claim that integration was
proven and cannot discard tracked or ordinary untracked changes. Start with
`dry_run=true`. Do not delete the preserved branch until its work has actually
been accounted for.

`agent_worktree_recover` can restore missing tracked files in a partial checkout
only with an unchanged index and no surviving tracked edits. Restore does not
overwrite remaining edits or reconstruct lost uncommitted content. Unknown,
sparse or conflicting states remain blocked. Its remove action retains the
branch.

## Build artifacts

The default remains explicit `remove_ignored_artifacts=true` after review.
Providers must leave build artifacts for Gateway maintenance and must not make
junctions/symlinks into the original workspace to share `node_modules`.

An optional persistent setting enables cleanup of newly created ignored build
artifacts when a managed job finishes:

```toml
# Under [mcp_servers.agent.env]; same key/string under Claude MCP env.
AGENT_MCP_AUTO_CLEAN_IGNORED_ARTIFACTS = "true"
```

The default is `false`. Only new managed worktrees with a recorded baseline are
eligible. Automatic cleanup is limited to new Git-ignored `build/` and
`.gradle/` outputs after fresh idle checks. Preexisting ignored data, tracked
changes, ordinary untracked files, links and unknown ownership are preserved.
Failure adds cleanup evidence rather than changing the provider's task result.
This does not change Codex approval policy or authorize dependency downloads.

## Status and progress

Worktree status separates ignored file counts/directories from tracked changes.
Large list responses keep semantic job rows rather than dropping all but five
records. Review text is retained inline when it fits after diagnostics are
reduced. Very large text is explicitly marked as truncated; the immutable
`details.artifact` contains the complete result, command output and PID evidence.

Codex progress uses structured CLI events and an attributable session JSONL
fallback. It reports observed commands, changes and phase, including completion
pending process cleanup. It does not infer CPU usage or claim tests passed from
a phase label. Missing evidence remains `unavailable`; a quiet job is not
automatically replayed or cancelled.

## Safety and verification limits

The Gateway cannot atomically exclude unrelated manual writers between a scan
and a filesystem operation. Keep target-worktree writers stopped during
maintenance. Process inspection does not enumerate every OS file handle;
unknown relevant identity/path evidence and actual file locks can still block.
All Git removals retain full no-follow link scans and mutation guards. Automated
tests use disposable repositories and mock providers, not production worktrees
or live paid model prompts.
