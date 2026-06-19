# 250 Codex Live Spawn Smoke Closeout

Status: ready
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

## Validation

- `cargo check --workspace`
- targeted tests for touched crates
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the next gate needs operator intent.
