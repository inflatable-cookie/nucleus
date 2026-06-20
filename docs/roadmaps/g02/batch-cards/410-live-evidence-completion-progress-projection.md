# 410 Live Evidence Completion Progress Projection

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../089-live-evidence-completion-projection.md`

## Purpose

Rebuild task-work completion progress from persisted live evidence completion
records.

## Scope

- Collapse persisted completion records into latest work-item completion state.
- Surface duplicate, blocked, and missing-evidence repair state.
- Keep projection deterministic.

## Acceptance Criteria

- [x] Persisted completions mark work items complete in projection.
- [x] Blocked and duplicate completions do not mark complete.
- [x] Missing evidence surfaces as repair state.
- [x] Projection grants no mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_progress_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
