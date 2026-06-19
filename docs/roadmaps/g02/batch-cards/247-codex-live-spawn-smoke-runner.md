# 247 Codex Live Spawn Smoke Runner

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../056-codex-live-spawn-smoke-gate.md`

## Purpose

Wire the constrained smoke request to existing local process primitives where
safe.

## Scope

- Use explicit command, timeout, output limit, and cleanup policy.
- Prefer existing local process/read-only spawn infrastructure.
- Do not send provider turns or callbacks.

## Acceptance Criteria

- Runner can report accepted, blocked, failed, timed-out, and cleanup-required
  outcomes.
- Output capture remains bounded.
- Process cleanup is explicit.

## Result

Implemented `run_codex_live_spawn_smoke`, adapting the constrained Codex smoke
request into the existing local read-only spawn boundary and mapping results
into Codex-specific smoke outcomes.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if running Codex would require unbounded output or provider credentials
  in records.
