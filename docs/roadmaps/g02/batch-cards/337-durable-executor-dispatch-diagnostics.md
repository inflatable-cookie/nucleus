# 337 Durable Executor Dispatch Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../074-codex-durable-executor-dispatch-gate.md`

## Purpose

Expose read-only diagnostics for durable executor dispatch readiness and
progress.

## Scope

- Show selection, admission, dispatch attempt, status, receipt, outcome, and
  evidence refs.
- Route diagnostics through the Codex provider diagnostics surface.
- Keep diagnostics sanitized and authority-free.

## Acceptance Criteria

- [x] Diagnostics expose dispatch readiness and blocked reasons.
- [x] Diagnostics expose linked outcome/status refs.
- [x] Diagnostics do not expose raw provider material.
- [x] Diagnostics do not grant provider, task, review, callback, interruption,
      recovery, or SCM authority.

## Validation

- `cargo test -p nucleus-server durable_executor_dispatch_diagnostics -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
