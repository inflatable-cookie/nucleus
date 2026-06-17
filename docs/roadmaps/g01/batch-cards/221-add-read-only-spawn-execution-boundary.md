# 221 Add Read-Only Spawn Execution Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first real read-only spawn execution boundary.

## Scope

- Name the execution boundary and inputs.
- Keep command invocation structured.
- Keep shell passthrough and PTY out.
- Keep behavior local-only.

## Out Of Scope

- Remote execution.
- Interactive terminal support.
- Write-enabled commands.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Boundary compiles.
- Boundary rejects shell passthrough and PTY-shaped requests.
- No process is spawned without host readiness.
