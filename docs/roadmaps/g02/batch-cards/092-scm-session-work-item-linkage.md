# 092 SCM Session Work Item Linkage

Status: completed
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

- [x] Work items can cite SCM session command evidence by reference.
- [x] Checkpoint/diff refs stay distinct from provider change refs.
- [x] Missing session evidence surfaces as repair state.

## Outcome

- Linked SCM session command ids into engine work-item SCM evidence records.
- Preserved checkpoint and diff refs separately from provider change refs.

## Validation

- [x] `cargo test -p nucleus-engine scm`
- [x] `cargo test -p nucleus-engine task_work`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if work-item linkage needs raw provider output.
