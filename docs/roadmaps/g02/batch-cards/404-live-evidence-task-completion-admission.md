# 404 Live Evidence Task Completion Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../088-explicit-live-evidence-task-completion.md`

## Purpose

Admit explicit operator task-completion commands over persisted accepted live
evidence review decisions.

## Scope

- Require persisted review decision status.
- Require `Accept` review decision.
- Require operator ref and completion evidence refs.
- Reject provider writes, callback, cancellation, resume, SCM mutation, and raw
  material requests.

## Acceptance Criteria

- [x] Accepted persisted review admits completion.
- [x] Rejected, needs-changes, abandoned, duplicate, and blocked decisions are
      not admitted.
- [x] Missing operator or evidence blocks completion.
- [x] Admission grants no provider or SCM authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_completion_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
