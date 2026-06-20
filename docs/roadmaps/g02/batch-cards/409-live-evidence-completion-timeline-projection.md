# 409 Live Evidence Completion Timeline Projection

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../089-live-evidence-completion-projection.md`

## Purpose

Project persisted live evidence task-completion records into deterministic task
timeline entries.

## Scope

- Derive timeline ids from task, work item, and completion refs.
- Skip blocked and duplicate completion records.
- Preserve operator and evidence refs.
- Keep timeline projection read-only and replay-safe.

## Acceptance Criteria

- [x] Persisted completion creates a deterministic timeline entry.
- [x] Blocked and duplicate completions are skipped.
- [x] Timeline entries retain refs, not raw provider material.
- [x] Projection grants no provider, SCM, or client mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_timeline_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
