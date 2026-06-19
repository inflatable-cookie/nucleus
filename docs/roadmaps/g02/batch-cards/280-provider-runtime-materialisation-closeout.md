# 280 Provider Runtime Materialisation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../062-provider-runtime-materialisation-gate.md`

## Purpose

Close the provider-runtime materialisation lane and select the next runtime
gate.

## Scope

- Validate code and docs.
- Update gap indexes and long-term plan.
- Choose task-state mutation or live provider command reactor as the next gate.

## Acceptance Criteria

- Roadmap state has one clear next task.
- The next gate is explicit.
- Validation passes or blockers are recorded.

## Validation

- [x] `cargo check --workspace`
- [x] targeted tests for touched crates
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if the next gate needs operator intent.

## Result

Selected `063-provider-command-reactor-gate.md` as the next gate.

Task-state mutation remains blocked. The next work is provider command reactor
records, outcome persistence, and Codex turn-start/callback dry-run routing
before any live provider send is allowed.
