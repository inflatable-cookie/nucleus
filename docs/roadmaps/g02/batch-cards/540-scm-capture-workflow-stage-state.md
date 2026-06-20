# 540 SCM Capture Workflow Stage State

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../115-scm-capture-workflow-composition.md`

## Purpose

Project SCM capture workflow stage state from linked records.

## Scope

- Represent missing, ready, completed, blocked, and repair-required stages.
- Preserve partial workflow evidence.
- Keep failed and blocked states inspectable.

## Acceptance Criteria

- [x] Stage state is deterministic.
- [x] Partial records remain visible.
- [x] Repair-required and blocked states are distinct.
- [x] No stage grants mutation authority.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_stage_state -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
