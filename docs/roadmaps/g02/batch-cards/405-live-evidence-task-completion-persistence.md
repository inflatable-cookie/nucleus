# 405 Live Evidence Task Completion Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../088-explicit-live-evidence-task-completion.md`

## Purpose

Persist explicit task-completion decisions derived from accepted live evidence
review decisions.

## Scope

- Store completion records by task/work/review refs.
- Preserve duplicate completion handling.
- Reject raw provider material and raw streams.
- Keep completion as task authority only, not provider or SCM authority.

## Acceptance Criteria

- [x] Completion records survive reopen.
- [x] Duplicate completion requests no-op deterministically.
- [x] Raw material requests block persistence.
- [x] Persisted records are reference-only.

## Validation

- `cargo test -p nucleus-server live_evidence_task_completion_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
