# 149 Add Minimal Local Read Only Command Runner Skeleton

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first server-owned command runner skeleton for local read-only
inspection commands.

## Scope

- Add a runner module behind server command authority.
- Accept only the contract-approved read-only subset.
- Return sanitized evidence.
- Keep timeout and cancellation posture explicit.

## Out Of Scope

- Network access.
- Source-code writes.
- Management-state writes.
- Secret access.
- Destructive commands.
- PTY streaming.
- Artifact payload storage.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Acceptance Criteria

- Unsupported scopes are rejected before process execution.
- Read-only command skeleton returns sanitized evidence.
- Tests prove policy gates before execution.

## Closeout

- Added `LocalReadOnlyCommandRunner` in `nucleus-server`.
- Added structured invocation metadata and rejection reasons.
- The skeleton emits sanitized `Queued` evidence for accepted requests and
  `BlockedByPolicy` evidence for unsupported requests.
- No subprocess execution, shell, PTY, raw output retention, network command,
  secret access, or mutation path was added.
