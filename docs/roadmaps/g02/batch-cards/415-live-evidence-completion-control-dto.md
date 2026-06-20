# 415 Live Evidence Completion Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../090-live-evidence-completion-control-read-model.md`

## Purpose

Define sanitized control DTOs for live evidence completion projections.

## Scope

- Represent timeline entries, completed work items, skipped refs, repair refs,
  and diagnostics.
- Exclude raw provider material and live handles.
- Keep client authority false.

## Acceptance Criteria

- [x] DTO serializes and round-trips.
- [x] DTO includes projection refs and repair refs.
- [x] DTO excludes raw material and live handles.
- [x] DTO grants no client mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
