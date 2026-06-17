# 040 Health Reset Validation

Status: ready
Owner: Tom
Updated: 2026-06-17
Milestone: `../012-health-and-authority-surface-reset.md`

## Purpose

Close the health reset after code and docs splits are complete.

## Scope

- Run the full targeted health validation for milestone 012.
- Record any remaining warning-level pressure as follow-on debt.
- Mark milestone 012 complete only if doctor has no error findings.
- Advance `docs/roadmaps/README.md` to the next active implementation lane.

## Acceptance Criteria

- `effigy doctor` has no error findings.
- Docs QA passes.
- Workspace Rust check passes.
- G02 indexes and current-lane docs agree.

## Validation

- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo check --workspace`
- `cargo test -p nucleus-agent-protocol`
- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server`
- `git status --short`

## Stop Conditions

- Stop if doctor still has error findings after the planned splits.

