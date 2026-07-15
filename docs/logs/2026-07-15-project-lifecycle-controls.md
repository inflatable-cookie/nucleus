# Project Lifecycle Controls

Date: 2026-07-15
Lane: g04 project control workflow

## Outcome

- added server-owned name-only durable project creation
- added typed rename, park, archive, restore, and guarded delete actions
- enforced actor, exact revision, idempotency, and authority-host admission
- persisted lifecycle receipts separately from project list records
- refused deletion when retained resources or project-scoped work remain
- added compact inline creation and overflow-menu controls to the project rail
- kept the working rail active-only with all, parked, and archived management
  views in one viewport-safe dialog
- made native browser views yield while the management dialog is open
- allowed resource-free projects to open a host-routed terminal from the
  authoritative host user's home directory
- surfaced lifecycle conflicts and refusal reasons without modal churn

## Evidence

- focused project, request-envelope, persistence, and desktop-host tests pass
- project-list and rejected-receipt regression tests pass
- workspace Rust check passes
- Svelte diagnostics report zero errors and zero warnings
- desktop production build passes
- docs QA passes

## Next

Operator-check the rail, restart continuity, guarded deletion, and empty-project
chat/task behavior before resource attachment controls begin.
