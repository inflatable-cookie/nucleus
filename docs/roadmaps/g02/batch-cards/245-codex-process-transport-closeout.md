# 245 Codex Process Transport Closeout

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../055-codex-process-and-transport-acceptance.md`

## Purpose

Close the Codex process and transport acceptance lane and select the next gate.

## Scope

- Validate code and docs.
- Update system inventory, implementation gap index, and long-term plan.
- Select the next gate: live spawn execution, callback responses, cancellation,
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
