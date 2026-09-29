# Implementation through local tests

Implementation providers may run project builds/tests, diagnose failures, edit within scope and rerun within the original job deadline. Supported workflows include Gradle/Maven wrappers, Python/pytest, npm scripts, and Bash/PowerShell scripts, subject to installed runtimes and project setup. The gateway does not install global runtimes automatically or authorize deployments/production changes.

- Grok: ACP implementation permissions allow shell commands; its client terminal supports immediate creation, incremental bounded output, actual exit status, kill/release and deadline/cancellation process-tree termination. Initial terminal cwd must remain inside the supplied workspace; subdirectories are supported. Commands with explicit argv preserve their arguments. Unstructured Windows commands use PowerShell; POSIX commands use Bash. Explicit Bash requires Bash installed (Git for Windows is discovered when available).
- Claude: implementation may use Bash; read-only tasks retain their restricted tool set. Actual transcript observations supply command telemetry where available.
- Codex: implementation retains workspace-write sandbox and native shell. Read-only tasks remain read-only. Native JSON command events supply command telemetry where available.

`commandExecutions` contains observed commands and available cwd/exit/output data. Missing fields remain null/unavailable. Agent summaries alone do not establish execution. A nonzero test exit is an observed command failure, not necessarily a failed overall implementation: the agent may fix it and rerun. Parent checks all tests, unresolved failures and the final diff before integration.

Shells execute project code with local user permissions (subject to the provider's sandbox). File-tool `allowed_paths` is not a shell sandbox; a worktree isolates checkout files, not machine access. Scripts and build caches can write outside that checkout. Provider prompts require respecting task scope, preserving unrelated changes, and avoiding deployments, credential changes and nested agent calls. Missing environments and blocked commands must be reported; do not claim unexecuted tests passed.

Generated build/dependency artifacts may prevent managed worktree cleanup. Parent reviews and removes disposable artifacts after integration/testing, then invokes cleanup. Failure, cancellation, or unintegrated work remains preserved.

Reconnect MCP after active work completes. No CLI update is required by this change.

## Focused continuation
Grok continuation keeps cwd and tool unchanged. allowed_paths may be reordered or narrowed to descendants of the immediately previous scope; broadening requires a new session. The narrowed scope is saved, so pass it again on later resumes (omitting allowed_paths defaults to the whole cwd and can be rejected). Current instructions override broader prior task scope. File-tool checks enforce the new scope; shell commands still rely on provider compliance and the existing execution policy, not an allowed_paths filesystem sandbox.

Implementation prompts prioritize the smallest failing compile/test command, directly related files, a minimal evidence-backed fix, and verification before broader reading. This is guidance, not a runtime speed guarantee or automatic cancellation threshold.

