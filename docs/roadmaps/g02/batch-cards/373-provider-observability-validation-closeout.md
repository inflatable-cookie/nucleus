# 373 Provider Observability Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../081-provider-observability-diagnostics.md`

## Purpose

Validate provider observability diagnostics and activate task-backed live
workflow closeout.

## Scope

- Run targeted and workspace validation.
- Update roadmap and gap indexes.
- Keep one clear next task.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Observability remains read-only and sanitized.
- [x] `082` is activated only after diagnostics are stable.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
