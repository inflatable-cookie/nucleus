# 429 Server Client Query Surface Inventory

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../108-server-client-workflow-hardening.md`

## Purpose

Inventory current read-only query/control surfaces across server, `nucleusd`,
Tauri IPC, and desktop proof UI.

## Acceptance Criteria

- [x] Inventory lists query name, server handler, control-envelope support,
  `nucleusd` support, Effigy task support, Tauri IPC support, and desktop proof
  UI support where present.
- [x] Inventory marks provider-effect-free status.
- [x] Inventory records missing parity without adding implementation.

## Result

Added `docs/architecture/server-client-query-surface-inventory.md`.

## Stop Conditions

- Inventory requires provider execution or raw provider payload inspection.
