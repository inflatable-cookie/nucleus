# 406 Live Evidence Task Completion Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../088-explicit-live-evidence-task-completion.md`

## Purpose

Expose read-only diagnostics for explicit task completion from live evidence.

## Scope

- Count admitted, blocked, persisted, duplicate, and completed states.
- Surface blockers and evidence refs without raw provider material.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics summarize completion admissions and persisted decisions.
- [x] Blocked and duplicate states are visible.
- [x] No raw material appears in DTOs.
- [x] Clients receive no mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_completion_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
