# 379 Durable Codex Live Smoke Boundary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../083-durable-codex-live-smoke-execution.md`

## Purpose

Define the durable live-smoke request and authority boundary for Codex.

## Scope

- Reuse existing durable dispatch, invocation, and live executor authority
  vocabulary where possible.
- Keep default mode dry-run only.
- Require explicit operator confirmation and an effect flag before a real
  provider write can be eligible.
- Preserve task-backed workflow identity without granting task, review,
  callback, cancellation, resume, or SCM authority.

## Acceptance Criteria

- [x] Boundary records distinguish dry-run, confirmed, and effect-requested
      modes.
- [x] Missing confirmation blocks real provider writes.
- [x] Effect flag without confirmation blocks real provider writes.
- [x] Accepted boundary still reports no provider write until the runner is
      invoked.

## Result

Added `provider_durable_codex_live_smoke_boundary`, covering dry-run,
confirmation-only, and confirmation-plus-effect modes over durable executor
handoff records without executing provider I/O.

## Validation

- `cargo test -p nucleus-server durable_codex_live_smoke_boundary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
