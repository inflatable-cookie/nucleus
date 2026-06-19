# 275 Codex Recovery Closeout

Status: completed
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

- [x] Roadmap state has one clear next task.
- [x] The next gate is explicit.
- [x] Validation passes or blockers are recorded.

## Result

- Closed the Codex session recovery lane after recovery need, admission,
  envelope, receipt, and diagnostics records were implemented.
- Confirmed task-state mutation stayed out of scope.
- Selected provider-runtime materialisation as the next gate before task-state
  mutation. This follows the T3 Code comparison: Nucleus should route the new
  diagnostics through the control API and start shaping provider-service and
  provider-instance runtime ownership before runtime observations mutate tasks.

## Validation

- [x] `cargo check --workspace`
- [x] `cargo test -p nucleus-server recovery -- --nocapture`
- [x] `cargo test -p nucleus-server codex_recovery -- --nocapture`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if the next gate needs operator intent.
