# 343 Durable Dispatch Invocation Diagnostics Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../075-codex-durable-dispatch-invocation-gate.md`

## Purpose

Expose durable dispatch invocation progress through read-only diagnostics,
validate the lane, and choose the next runtime step.

## Scope

- Show preflight, invocation request, handoff, outcome, receipt, durable
  status, and evidence refs.
- Route diagnostics through the Codex provider diagnostics surface.
- Keep diagnostics sanitized and authority-free.

## Acceptance Criteria

- [x] Diagnostics expose invocation readiness and blocked reasons.
- [x] Diagnostics expose handoff/outcome/status refs.
- [x] Diagnostics do not expose raw provider material.
- [x] Validation passes or blockers are recorded.
- [x] Roadmap state has one clear next task.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
