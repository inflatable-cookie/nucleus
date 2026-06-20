# 411 Live Evidence Completion Read Model Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../089-live-evidence-completion-projection.md`

## Purpose

Expose read-only diagnostics for live evidence completion timeline and progress
projections.

## Scope

- Count timeline entries, skipped completions, completed work items, and repair
  states.
- Include sanitized refs only.
- Keep client authority false.

## Acceptance Criteria

- [x] Diagnostics summarize timeline/progress projection state.
- [x] Skipped and repair states are visible.
- [x] No raw material appears in DTOs.
- [x] Clients receive no mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_read_model_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
