# 275 Codex Recovery Closeout

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Close the recovery/resume lane and select the next runtime gate.

## Scope

- Validate code and docs.
- Update gap indexes and long-term plan.
- Select the next gate, likely task-state mutation from runtime observations.

## Acceptance Criteria

- Roadmap state has one clear next task.
- The next gate is explicit.
- Validation passes or blockers are recorded.

## Validation

- `cargo check --workspace`
- targeted tests for touched crates
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the next gate needs operator intent.
