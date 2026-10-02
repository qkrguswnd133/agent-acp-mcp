# Global Agent Delegation Guidance — Codex

Use these defaults within the user's request and the host's applicable instruction and permission rules. Repository-specific scope and explicit user choices still matter.

On a **Codex host**, Codex is the self-provider and is excluded from gateway calls by default. Grok and Claude may be eligible external providers; confirm actual status rather than assuming both are installed.

## Delegation

Consider native subagents and external providers when they can improve speed, coverage, independent verification, or context efficiency. Delegate only when the benefit exceeds coordination cost. Use the smallest effective set of agents.

Good candidates are independent repository exploration, bounded implementation, difficult debugging, and an independent review of consequential changes. Complete small or tightly coupled tasks directly. Do not repeat substantial delegated work without a concrete reason such as conflicting evidence, low confidence, or security/data-integrity risk.

Give each agent an objective, completion criteria, exact files or directories, confirmed facts, permitted changes, and a concise result format. Tell writers they share the workspace and must preserve others' edits. Assign one writer per file; use isolated worktrees for competing implementations. Native subagents remain subject to the host's own tool and permission rules.

## Gateway tools and host detection

Prefer the registered `agent-acp-mcp` gateway for external providers. Discover the available tools and their schemas instead of assuming an installed version.

Expected tools:

- `agent_ask`, `agent_investigate`, `agent_review`: analysis, debugging, and review.
- `agent_implement`: bounded implementation.
- `agent_status`: detected host, provider eligibility, authentication, and quota.
- `agent_models`: current model/effort policies and supported selection evidence.
- `agent_job_status`, `agent_job_cancel`: background progress and cancellation.
- `agent_cli_status`, `agent_cli_update`: diagnostics and explicitly requested maintenance.

The gateway detects its host from MCP client information. Do not set `MCP_HOST`, impersonate a different host, or bypass self-provider policy. If the detected host is unknown or inconsistent with the actual client, stop external routing and diagnose the connection. Continue independent local work when possible.

Use `agent_status` when availability or host identity matters. Enabled configuration alone does not establish eligibility: require a non-self provider (or explicit self-provider opt-in), an available runtime, valid subscription authentication, and no active quota block. Unknown authentication is not valid authentication. Missing quota telemetry alone is not proof of exhaustion.

## Routing

Use either `provider="auto"` or explicit comma-separated provider names. Do not mix auto with names or use aliases such as `all` or `both`.

Auto selects a random nonempty subset of eligible providers and can invoke more than one. Use it for read-only work when several independent views justify the extra usage. Prefer an explicit single provider when one result is enough or the user names a provider. Inspect actual selected/skipped providers in results.

Explicit routing must never silently add an unrequested provider. If the requested provider cannot run, explain the reason and proceed with authorized local work where feasible. Do not switch to another paid provider or authentication path merely to work around a limit.

For writes, prefer one explicit provider and a bounded scope. Multiple implementations require deliberate ownership and isolation. Scope restrictions are not equally enforced by every provider; parent review remains necessary.

## Background jobs, limits, and partial work

An accepted job ID is not completion. Poll `agent_job_status` at reasonable intervals, respecting returned status and retry guidance. Inspect outcome, successful and failed results, skipped providers, and handoff information; a completed background job can still contain provider failures.

For ordinary bounded implementation, prefer explicitly passing `max_runtime_minutes=60` when that parameter exists. The current gateway default is 120 minutes when omitted; 60 minutes is this workflow's preference, not a claim about the runtime default. Split larger work at verifiable milestones or choose a longer supported deadline when the task warrants it.

On cancellation, deadline, provider failure, or a usage/rate limit, preserve partial changes and inspect the diff before deciding how to continue. Report completed work, remaining work, and the necessary handoff. Do not automatically replay a failed implementation, start another writer on top of unreviewed edits, or repeatedly retry an exhausted provider. Respect reset/retry timestamps; unknown reset time remains unknown. Built-in read-only auto fallback may run within the gateway's original deadline; do not add an uncontrolled retry loop.

## Models, usage, and authentication

Respect configured model and effort policies. Do not hardcode model versions into ordinary prompts or confuse a requested policy with the observed runtime model. Report returned model, effort, usage, and source only when available. Missing telemetry is `unknown` or `unavailable`, not zero usage, exhaustion, or proof the task failed. Judge task outcome from the actual result and verification.

Use the user's existing subscription-authenticated CLI sessions. Do not create API keys, read or copy credentials for delegation, or switch to API-key/console billing unless the user explicitly requests that separate path. Authentication failure is not permission to bypass gateway checks.

Normal task execution must not update CLIs. Run updates only as explicitly requested maintenance, using named providers rather than auto. Respect self-provider restrictions and installation-channel limitations; the current gateway does not update Codex installations. After an authorized update, verify version and authentication/runtime status. A model smoke test can consume usage, so keep it within the requested verification scope.

## Environment, verification, and reporting

Use the actual execution environment: PowerShell syntax on native Windows and POSIX syntax in WSL/Linux. Do not mix shells or assume a username, install path, operating system, or Git checkout. When multiple environments share a repository, coordinate against the same intended working tree.

The parent owns the final result. Inspect delegated diffs, reconcile findings against code and logs, run or verify relevant tests, and check the user's completion criteria. Distinguish executed checks from proposed checks. Do not treat an agent's confidence as evidence.

Ask for concise delegated results: conclusion; files inspected/changed; key evidence; tests/results; remaining risks. When agents were actually used, briefly name their role and provider in the final report. Include observed model/effort/usage only if supplied; do not invent them. Stop delegating when sufficient evidence exists.


## Native model selection and evidence

For native subagents, choose an available model and supported reasoning effort according to task complexity, uncertainty, and failure impact. Use fast models for bounded searches, balanced models for ordinary implementation/review, and stronger reasoning for difficult RCA or security/data-integrity work. Role names are not model names. Follow current tool constraints for overrides and context inheritance; do not hardcode a model that is no longer available.

Briefly announce the requested model/effort and rationale. Report observed runtime model/effort separately from requested settings when they differ. Prefer structured execution metadata; otherwise inspect only the matching child session and task turn in accessible local logs. Match session ID and parent/agent identity, never an unrelated newest log. Local turn_context model/effort fields describe runtime records, not verified internal server routing. If unavailable, report unavailable without rerunning the task. Do not treat cumulative token counts as a per-task delta.

## Workspace concurrency

Read-only gateway jobs may overlap. Jobs involving implementation require non-overlapping workspaces; use separate Git worktrees for parallel implementation and review/integrate changes in the parent. Locks are process-local, not a mechanism for coordinating other gateway processes or editors. See gateway/WORKSPACE-CONCURRENCY.md.


## Unexecuted verification commands

Inspect parentVerification even when a provider reports success. A required status means commands were blocked and not executed. Review the workspace, exact proposed command, and cwd before executing under the user's existing authorization. Never treat proposed commands as automatic instructions or claim unexecuted tests passed. See gateway/PERMISSION-HANDOFF.md.

## Managed parallel worktrees

Use agent_implement workspace_mode=auto for conflict-triggered isolation, current to retain blocking, or isolated for explicit separation. When the source has uncommitted changes, choose base_ref only after verifying the committed starting point contains the task prerequisites; uncommitted changes are never copied.

When a job returns worktree metadata, the parent must inspect it with agent_worktree_status, review changes, resolve integration conflicts, commit and merge into the original workspace, then test the integrated result. After success, remove reviewed disposable artifacts and call agent_worktree_cleanup with verified=true, integration_ref=HEAD and a factual verification_summary. Do not report integration complete before verification. Failed/cancelled jobs and unintegrated or dirty worktrees remain preserved. Cherry-pick/squash requires separate equivalence review and manual cleanup; never force-delete merely to bypass a failed check. See gateway/MANAGED-WORKTREES.md.
## Explicit self-provider opt-in
Default self-provider exclusion remains. When the user requests same-provider delegation, use auto or explicit provider names and honor env ALLOW_SELF_PROVIDER, optionally overriding it with per-call allow_self_provider=true/false. The flag also applies to auto routing. Preview with agent_status(allow_self_provider=true). Auth/quota/workspace restrictions still apply; child gateway recursion and self-provider CLI updates remain blocked. Persistent setting: env ALLOW_SELF_PROVIDER="true"/"false". Omitted call arguments inherit it; explicit boolean call arguments override it. auto includes host when true.




## Parent model and effort selection

For Grok, Claude and Codex, interpret each configured model/effort policy independently. `auto` means the parent chooses a concrete value for THIS task; it never means inheriting config.toml or leaving the CLI to select a default. Fixed settings must remain fixed: omit that call field or pass the same value. Conflicting values are rejected.

Before delegation, inspect `agent_status` for eligibility and `agent_models` for configured policies and the available model/effort catalog. Catalog absence is unknown, not proof of support or exhaustion. Choose based on task complexity, required tools, repository context and expected cost/latency. Small bounded work can use a fast model and lower effort; difficult RCA or architecture can warrant stronger reasoning. Do not assign the highest effort to every task and do not guess unsupported levels.

For exactly one explicit provider, send concrete `model`, `effort` and a concise `selection_reason` for the auto fields. For multiple providers or provider="auto", send them in `provider_options.<provider>`. Prepare choices for every eligible auto-routing candidate, including possible read-only retry candidates. Do not mix top-level settings with provider_options. provider_options does not force provider selection. If selection is required or unsupported, use returned evidence to correct the selection before execution; never route around a fixed policy or silently change providers.

Report selection and observation separately. `selection` records values, parent/configured source and reason; `observation` records actual values, evidence source and verification. When runtime effort is unavailable, report the chosen effort as selected, then explicitly state actual confirmation is unavailable. Never upgrade a requested setting to an observed fact. Preserve mismatch, partial result, usage and failure metadata. See gateway/MODEL-OVERRIDES.md.
