# 327 Provider Recovery Execution Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../072-codex-provider-recovery-execution-gate.md`

## Purpose

Expose read-only diagnostics for Codex recovery execution state.

## Scope

- Add diagnostics read-model records for admitted, blocked, completed, failed,
  timed-out, cleanup-required, and replacement-thread-observed recovery
  execution states.
- Route the diagnostics through the Codex provider diagnostics surface.
- Keep diagnostics sanitized and authority-free.

## Acceptance Criteria

- [x] Diagnostics expose recovery refs, task/work refs, write-attempt refs,
      receipt refs, and evidence refs.
- [x] Diagnostics do not expose raw provider material.
- [x] Diagnostics do not grant provider, task, review, callback, interruption,
      replacement-thread promotion, or SCM authority.

## Validation

- `cargo test -p nucleus-server recovery_execution_diagnostics -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
