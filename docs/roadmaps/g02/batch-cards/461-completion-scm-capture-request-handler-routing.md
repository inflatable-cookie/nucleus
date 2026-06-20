# 461 Completion SCM Capture Request Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../099-completion-scm-capture-diagnostics-control-integration.md`

## Purpose

Route persisted capture-admission diagnostics through the server request
handler.

## Scope

- Read persisted capture admissions.
- Return empty diagnostics when no records exist.
- Keep handler read-only.

## Acceptance Criteria

- [x] Handler returns capture-admission diagnostics.
- [x] Persisted admissions produce counts.
- [x] Missing state is empty, not invented.
- [x] Handler cannot execute external effects.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
