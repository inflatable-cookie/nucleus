# 226 Add Server Read-Only Spawn Helper

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a server-owned helper that prepares and calls the read-only spawn boundary.

## Scope

- Accept structured request and invocation values.
- Require a host readiness gate.
- Return sanitized spawn result.

## Out Of Scope

- Desktop UI.
- General command execution API.
- Write-enabled commands.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Helper compiles.
- Helper does not bypass host readiness.
- Tests prove blocked readiness prevents execution.

## Closeout

Added `ServerReadOnlySpawnInput`, `ServerReadOnlySpawnResult`, and
`run_server_read_only_spawn`.

The helper accepts a pre-built `LocalReadOnlySpawnInput`, calls the bounded
spawn boundary, and persists sanitized command evidence through
`write_command_evidence`. It does not build or bypass the host-spawn readiness
gate.
