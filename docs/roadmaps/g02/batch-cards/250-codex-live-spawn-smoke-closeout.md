# 250 Codex Live Spawn Smoke Closeout

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../056-codex-live-spawn-smoke-gate.md`

## Purpose

Close the live spawn smoke lane and select the next Codex runtime gate.

## Scope

- Validate code and docs.
- Update gap indexes and long-term plan.
- Select the next gate: turn start, callback responses, cancellation,
  recovery, or subscriptions.

## Acceptance Criteria

- Roadmap state has one clear next task.
- The next gate is explicit.
- Validation passes or blockers are recorded.

## Result

Roadmap `056` is complete. Roadmap `057` is the next active lane, focused on
Codex turn-start admission and request envelopes before callback, cancellation,
recovery, subscription, or task-mutation behavior expands.

## Validation

- `cargo check --workspace`
- targeted tests for touched crates
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the next gate needs operator intent.
