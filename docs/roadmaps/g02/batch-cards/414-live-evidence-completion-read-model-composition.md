# 414 Live Evidence Completion Read Model Composition

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../090-live-evidence-completion-control-read-model.md`

## Purpose

Compose persisted live evidence completions into a server-side read model.

## Scope

- Accept persisted completion records.
- Build timeline projection, progress projection, and projection diagnostics.
- Preserve skipped and repair-required refs.
- Keep composition read-only.

## Acceptance Criteria

- [x] Read model composes timeline, progress, and diagnostics.
- [x] Ordering is deterministic.
- [x] Skipped and repair-required refs are preserved.
- [x] Composition grants no client mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_read_model -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
