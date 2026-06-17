# 040 Health Reset Validation

Status: completed
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

## Outcome

Completed 2026-06-17.

Validation passed:

- `effigy doctor`: 0 errors, 22 warning-level god-file findings
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo check --workspace`
- `cargo test -p nucleus-agent-protocol`
- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server`

Remaining warning-level file-size pressure is follow-on debt, not a blocker for
starting the client protocol and host transport runway. The largest remaining
warnings are in task storage codec, management projection, desktop CSS/Tauri
shell, SQLite storage, Codex adapter fixtures, control DTOs, request-handler
queries, and runtime diagnostics surfaces.
