# 433 Server Client CLI Tauri Parity

Status: planned
Owner: Tom
Updated: 2026-06-23
Milestone: `../108-server-client-workflow-hardening.md`

## Purpose

Keep `nucleusd` CLI and Tauri IPC coverage aligned for the selected read-only
model where both are expected to exist.

## Acceptance Criteria

- [ ] CLI output exposes sanitized counts/diagnostics only.
- [ ] Tauri IPC adapter can submit the same serialized query shape.
- [ ] Tests cover both paths where touched.
