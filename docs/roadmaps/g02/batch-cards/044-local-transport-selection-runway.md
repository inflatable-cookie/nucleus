# 044 Local Transport Selection Runway

Status: planned
Owner: Tom
Updated: 2026-06-17
Milestone: `../010-client-protocol-and-host-transport-runway.md`

## Purpose

Choose the first local transport implementation path after protocol shape,
host capability, and auth posture records are explicit.

## Scope

- Compare embedded in-process, Tauri IPC, local socket, named pipe, and
  loopback HTTP options against current architecture.
- Pick the first implementation target for desktop/local development.
- Define follow-on cards for implementation.
- Keep remote internet transport out of scope.

## Acceptance Criteria

- One first local transport target is selected with tradeoffs recorded.
- Embedded and sidecar workflows stay viable.
- The choice does not make the desktop renderer the authority.
- Follow-on cards are broad enough to implement meaningful chunks.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if transport choice depends on UI design decisions that are not settled.
