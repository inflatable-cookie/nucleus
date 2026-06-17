# 092 SCM Session Work Item Linkage

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Tie SCM session commands to task work items, checkpoints, diffs, and receipts.

## Scope

- Link session command evidence to work items.
- Preserve checkpoint and diff refs separately from provider change refs.
- Surface repair-required states.

## Acceptance Criteria

- Work items can cite SCM session command evidence by reference.
- Checkpoint/diff refs stay distinct from provider change refs.
- Missing session evidence surfaces as repair state.

## Validation

- `cargo test -p nucleus-engine scm`
- `cargo test -p nucleus-engine task_work`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if work-item linkage needs raw provider output.
