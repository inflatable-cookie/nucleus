# 285 Provider Command Reactor Closeout

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../063-provider-command-reactor-gate.md`

## Purpose

Close the provider command reactor gate and select the first live provider send
gate.

## Scope

- Validate reactor records and dry-run Codex paths.
- Update gap indexes and long-term plan.
- Choose the first live send gate or record blockers.

## Acceptance Criteria

- Roadmap state has one clear next task.
- The first live provider send gate is explicit or blocked.
- Validation passes or blockers are recorded.

## Validation

- [x] `cargo check --workspace`
- [x] targeted tests for touched crates
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if the first live provider send target needs operator intent.

## Result

Selected `064-codex-live-provider-send-readiness.md` as the next gate.

The first live-send target remains blocked until preflight, transport write
attempt, receipt/event, and operator policy records are explicit and tested.
Task mutation remains behind a later gate.
