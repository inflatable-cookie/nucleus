# 476 Completion SCM Capture Preparation Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../102-completion-scm-capture-preparation-control-integration.md`

## Purpose

Route persisted preparation diagnostics through the server request handler.

## Scope

- Read persisted preparation records.
- Return empty diagnostics when no records exist.
- Keep handler read-only.

## Acceptance Criteria

- [x] Handler returns preparation diagnostics.
- [x] Persisted records produce counts.
- [x] Missing state is empty, not invented.
- [x] Handler cannot execute external effects.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
