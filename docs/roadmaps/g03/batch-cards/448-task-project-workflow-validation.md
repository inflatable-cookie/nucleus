# 448 Task Project Workflow Validation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Validate the task/project workflow slice as one batch.

## Work

- [x] Run focused Rust tests for changed crates.
- [x] Run focused `cargo check` for changed crates.
- [x] Run CLI/Effigy smoke for new selectors.
- [x] Run docs and Northstar QA.
- [x] Run doctor and record warning-only status if unchanged.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] CLI/Effigy smoke passes.
- [x] Docs checks pass.
- [x] Doctor has zero errors or documented existing warnings only.

## Result

Validation passed:

- `cargo test -p nucleus-engine task_readiness`
- `cargo test -p nucleus-server task_readiness`
- `cargo test -p nucleusd task_readiness`
- `cargo test -p nucleusd query`
- `cargo check -p nucleus-engine`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:task-readiness`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

Doctor result:

- 147 warnings
- 0 errors
