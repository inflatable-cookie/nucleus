# 430 Server Client Gap Matrix

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../108-server-client-workflow-hardening.md`

## Purpose

Turn the query inventory into a gap matrix for read-only client workflows.

## Acceptance Criteria

- [x] Gaps are grouped by missing server handler, DTO, CLI, Tauri IPC, desktop
  proof UI, and tests.
- [x] The matrix distinguishes product-value gaps from cleanup-only gaps.
- [x] The matrix selects no more than two implementation candidates for the
  first hardening batch.

## Result

Added `docs/architecture/server-client-gap-matrix.md`.
