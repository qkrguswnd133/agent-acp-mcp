# Maintenance safety changes — 2.7.0

These changes apply to all three providers on Windows and Linux/WSL. Tests use disposable repositories, mock providers and temporary link targets. They do not use production worktrees, real dependency-directory links or live provider requests.

| Item | Cause and change | Main sources / regression coverage |
| --- | --- | --- |
| Junction deletion | Confirmed missing final link guard before Git recursive removal. All removal paths now share a full no-follow scan; opt-in unlink verifies target metadata and rescans. | `managed-worktree.ts`, `worktree-links.ts`; junction, nested link, symlink where supported, ancestor replacement, final-scan injection, target mutation |
| Stale cleanup locks | Confirmed zero-byte locks had no owner identity or expiry. JSON leases, audited recovery, heartbeat, fencing and unique guard claims replace them. | `maintenance-lock.ts`, `jobs.ts`; dead/reused/expired/legacy locks, valid foreign owner, real-process contention and stale-owner fencing |
| Request timeouts | Confirmed synchronous Windows identity lookups and per-file Git subprocesses could block/slow requests. Maintenance now acknowledges before running, uses asynchronous shared inventory and batched Git sets with fresh mutation guards. | `maintenance-operations.ts`, `jobs.ts`, `maintenance.ts`; 5,000 artifacts, concurrent unrelated job/status, drain and phase timings |
| False descendants | Confirmed PPID-only ancestry accepted pre-existing processes after parent PID reuse. Birth ordering and fresh generation checks now constrain tracking and termination. Unrelated/unknown workspace evidence preserves successful results with warnings. | `process-tree.ts`, `process.ts`, `process-cleanup.ts`, `router.ts`; reused parent, missing identity, referenced/unrelated/unknown workspace |
| Oversized replies | Confirmed full/duplicated diagnostics entered MCP output. Full data now lives in immutable artifacts; envelopes are under 20 KiB, including verbose requests. | `tool-payload.ts`, `index.ts`, `job-payload.ts`; 160 PID proofs, large reviews, duplicate proof removal, artifact-write failure |
| Cherry-pick visibility | Confirmed list/status exposed ancestry only. Bounded cached historical patch matches now include corresponding original commits. Cleanup still checks the current tree. | `managed-worktree.ts`; cherry-pick, negative match, reverted original tree |
| Multiple Gateways | Investigation only: observed seven instances under live Claude/Codex parents. Process inventory cannot prove whether their stdio pipes remain open. No missed EOF defect was demonstrated. | `gateway-idle-lifecycle.test.ts`, `mcp-job-lifecycle.test.ts`; idle with open stdin, exit after EOF, active work drains |

## Reproduce and verify

- Gateway: `cd gateway`, `npm test`. The test runner explicitly enumerates compiled files, so it works without shell glob expansion on Windows.
- MCP/release fixtures: from repository root, `node scripts/release-tests.mjs`.
- Linux: `node scripts/run-linux-validation.mjs --suite all --report build/linux-validation.json` on a native Linux runtime. The release builder requires a matching source-commit validation receipt.
- Signed Windows and Linux package/installer smoke tests are part of the release procedure. Production installation replacement is a separate user action.

The temporary 5,000-file Windows fixture confirmed millisecond-level operation acceptance; full cleanup is intentionally asynchronous and can take seconds or longer. Disk speed, antivirus and metadata verification affect elapsed time. Timings are returned with each operation instead of a hard-coded completion promise.

The packaged Windows updater smoke also checks creation-identity compatibility: `Get-Process.StartTime.Ticks` retains 100 ns precision, while CIM reports whole microseconds. Maintenance compares these existing updater identities at the observed CIM precision (one microsecond), with no wider time tolerance. Different creation-time buckets remain blocked. Linux identity comparison remains exact.

To diagnose idle processes, record Gateway and parent creation identities, keep a temporary Gateway's stdin open without sending work, then close stdin. Idle instances should remain while connected and exit on EOF; accepted jobs/maintenance should first persist their results. An old creation time alone does not establish a leak, so this version adds no age-based process killer. SIGKILL, host process-tree termination or power loss can still interrupt work.

## Upgrade and remaining limits

Use the signed Windows updater or Linux `agent-acp update`, then reconnect MCP to load `agent_operation_status` and optional fields. Merge the shipped parent-instruction changes intentionally; installers do not overwrite personal global instructions. Finish active work before installation. Existing worktrees, jobs, results and account settings are preserved; no automatic migration, cleanup or replay occurs.

Keep manual writers inactive during physical maintenance. Filesystem checks cannot atomically exclude unrelated applications between inspection and a Git operation. An incomplete link/process scan remains a blocker. Historical patch equivalence is informative, not independent cleanup authorization. Unknown remaining-process workspace usage preserves task success but does not authorize deleting its worktree.
