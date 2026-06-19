# 255 Codex Turn Start Closeout

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../057-codex-turn-start-admission-gate.md`

## Purpose

Close the Codex turn-start admission lane and select the next runtime gate.

## Scope

- Validate code and docs.
- Update gap indexes and long-term plan.
- Select the next gate: callback responses, cancellation, recovery,
  subscriptions, or task-state mutation from observations.

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
