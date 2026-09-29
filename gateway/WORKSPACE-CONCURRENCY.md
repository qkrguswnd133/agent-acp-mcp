# Workspace concurrency

- Independent `agent_ask`, `agent_review`, and `agent_investigate` jobs may run concurrently in the same or overlapping working directories.
- If either job is an implementation, overlapping working directories remain blocked. Different providers or `allowed_paths` do not bypass the lock.
- Use separate, non-overlapping Git worktree paths for parallel implementation. The parent must review and integrate the resulting changes. The gateway does not create worktrees automatically.
- Conflict errors identify the active job ID, job kind, provider information, and canonical working directory. Before provider selection, the provider value is the requested selection (possibly `auto`); after activity, it can identify the active provider. Grok's internal guard may report an unavailable job ID.
- Each read job retains its own guard until completion or cancellation cleanup. Unknown job kinds remain exclusive.
- These guards apply within the running gateway process. They do not coordinate separate gateway processes or unrelated editors; do not use another process to bypass a conflict.
- Existing running processes retain their loaded code. Reconnect MCP to apply an updated build without interrupting active work.


Update: agent_implement now defaults to workspace_mode=auto, which relocates a conflicting implementation into a managed worktree. workspace_mode=current keeps the earlier blocking behavior. See MANAGED-WORKTREES.md for base_ref, parent integration and verified cleanup.
