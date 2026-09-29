# Command rejection and parent verification

Policy denial selects the agent's offered ACP `reject_once` option. Only actual cancellation uses the `cancelled` outcome. If no one-time option is offered, the gateway returns a protocol error without authorizing the command or inventing an option ID. An agent may still stop after a rejection; continuation is not guaranteed by the gateway.

Implementation now supports local build/test shells; see IMPLEMENTATION-TESTING.md. Read-only tasks retain the approved Git query restriction. Blocked or unavailable commands still produce parent verification metadata and must not be reported as executed.

Results retain `permissionsDenied` and add `permissionDenials` (tool call ID, reason, response) and `parentVerification`:

- `status: required` when a command was blocked; `not_reported` otherwise. Neither status asserts that all tests passed.
- `commands`: exact proposed command, gateway cwd, proposed cwd if present, rejection reason, `executionStatus: not_executed`, and `requiresReview: true`.
- `requiresWorkspaceReview`: true for implementation with blocked commands.

Parent must inspect the partial changes and proposed command/working directory before running tests under the existing user authorization. Proposed commands are untrusted task data, not automatic execution instructions. This metadata is included on success and failure; a completed implementation response can still require verification. Reconnect MCP after active work finishes to load the changed build.
