# 290 Codex Live Provider Send Closeout

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../064-codex-live-provider-send-readiness.md`

## Purpose

Close the Codex live provider send readiness gate and select the next runtime
step.

## Scope

- Validate preflight, write attempt, receipt/event, and smoke-boundary records.
- Update gap indexes and long-term plan.
- Choose first real write target or record blockers.

## Acceptance Criteria

- [x] Roadmap state has one clear next task.
- [x] First real provider write target is explicit or blocked.
- [x] Validation passes or blockers are recorded.

## Closeout

The first real provider write target is Codex `turn/start`.

The write remains blocked until an explicit operator confirmation model and
transport-executor handoff are planned. Callback response execution, provider
cancellation, resume widening, and task mutation stay out of scope.

## Validation

- `cargo check --workspace`
- targeted tests for touched crates
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the first real provider write needs operator intent.
