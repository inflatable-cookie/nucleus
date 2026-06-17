# 222 Gate Spawn Through Host Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Require host-spawn readiness before any real spawn attempt.

## Scope

- Evaluate host-spawn readiness before execution.
- Preserve blocker detail on rejection.
- Keep acceptance distinct from execution result.

## Out Of Scope

- Remote execution.
- Desktop UI.
- Scheduler policy changes.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Blocked readiness prevents spawn.
- Ready gate allows the bounded runner path.
- Tests prove no bypass path.
