# 156 Draft Local Process Supervision Contract

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Draft the contract for local child-process supervision before any host process
spawning implementation is added.

## Scope

- Define process supervisor responsibilities.
- Define timeout, cancellation, environment, output, and sandbox rules.
- Name what the first host-spawn slice may and must not do.

## Out Of Scope

- Rust process spawning.
- PTY streaming.
- Raw artifact payload storage.
- Network, secret, destructive, SCM mutation, or provider lifecycle commands.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Process spawning prerequisites are explicit.
- The first allowed host-spawn subset is narrow.
- Remaining blockers are visible.

## Closeout

- Added local process supervision contract to the server boundary.
- Host process spawning remains blocked.
- The first allowed future host-spawn subset is local, read-only, low-risk,
  bounded-output, required-timeout, and summary-only by default.
