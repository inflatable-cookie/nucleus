# 301 Task Backed Hardening Closeout

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../066-task-backed-workflow-hardening.md`

## Purpose

Close the task-backed workflow hardening lane and choose the next bounded
runtime step.

## Scope

- Validate persistence, query, diagnostics, and transition checks.
- Promote any remaining source-record or projection-policy findings into
  contracts and the implementation gap index.
- Decide whether to run the explicit Codex real-write smoke or continue product
  hardening.

## Acceptance Criteria

- [x] Roadmap state has one clear next task.
- [x] Direct Codex provider writes remain blocked unless explicitly selected.
- [x] Validation passes or blockers are recorded.
- [x] Remaining task-backed workflow gaps are named clearly.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the next lane requires operator intent.
