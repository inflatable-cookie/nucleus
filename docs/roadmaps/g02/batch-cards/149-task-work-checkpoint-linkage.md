# 149 Task Work Checkpoint Linkage

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../034-task-work-checkpoint-and-review-loop.md`

## Purpose

Attach checkpoint refs to task work-unit outcomes.

## Scope

- Link existing checkpoint record vocabulary to work-unit outcomes.
- Preserve task, session, command, and runtime receipt refs.
- Do not create SCM checkpoints by mutation.

## Acceptance Criteria

- Work-unit outcomes can reference checkpoints.
- Missing checkpoints are explicit.
- No SCM mutation occurs.

## Validation

- `cargo test -p nucleus-engine checkpoint`
- `cargo test -p nucleus-server checkpoint`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if checkpoint linkage requires creating SCM state.
