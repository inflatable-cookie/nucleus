# 057 Empty Workspace And Reconnect Recovery

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../019-shell-context-cohesion.md`
Depends on: card 056
Auto-start next card: yes

## Objective

Give valid empty layouts and workspace-local connection failures one restrained,
usable recovery surface.

## Acceptance

- [x] an all-panels-closed retained layout is not silently reseeded
- [x] the empty state offers one direct `Open Agent Chat` action
- [x] loading, reconnecting, and failed states stay inside the workspace stage
- [x] retry reconnects the exact selected project without resetting its layout
- [x] project navigation remains available in every workspace state

## Validation

- [x] focused desktop fixtures pass
- [x] desktop type checking and diff hygiene pass

## Stop Conditions

- do not turn the empty state into a panel catalogue
- do not imply host repair authority

## Evidence

The stage treats a zero-panel authoritative snapshot as valid retained state.
It replaces the dock tree with one direct Agent Chat action and keeps the
header launcher available. Session state now uses the same reactive posture as
the existing lifecycle harness, so the final-panel close repaints immediately.
