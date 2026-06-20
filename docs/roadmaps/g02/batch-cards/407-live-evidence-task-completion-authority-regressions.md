# 407 Live Evidence Task Completion Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../088-explicit-live-evidence-task-completion.md`

## Purpose

Prove explicit task completion does not widen provider, callback, recovery,
interruption, SCM, or raw-material authority.

## Scope

- Exercise rejected, needs-changes, abandoned, duplicate, and blocked review
  decisions.
- Exercise completion admission and persistence with widened authority
  requests.
- Keep future SCM/share/change-request completion behavior out of this lane.

## Acceptance Criteria

- [x] Non-accepted review decisions never complete tasks.
- [x] Widened provider/callback/recovery/interruption/SCM requests block.
- [x] Raw material requests block.
- [x] Future change-request and SCM promotion lanes remain separate.

## Validation

- `cargo test -p nucleus-server live_evidence_task_completion_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
