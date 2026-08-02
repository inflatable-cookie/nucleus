# 017 Secondary-Window Panel Transfer

Status: conditional-paused
Owner: Tom
Created: 2026-08-01

## Purpose

Adopt Longhorn's Surface-free direct-window transfer only after Nucleus defines
a useful secondary workspace-window product shape.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/011-cross-window-transfer.md`

## Generation Runway Goal

Preserve a real multi-window path without burdening the current primary-window
workflow.

## Goals

- [ ] settle secondary-window roles, lifecycle, and project behavior
- [ ] admit complete measured target leases and direct-window host bindings
- [ ] move panels through authoritative layout mutation
- [ ] retain no-Surface storage and runtime state

## Execution Plan

### Batch 17.1 — Product Gate

- [ ] Execute card 051 after operator selection of a concrete secondary-window
  use case.
- [ ] promote window roles, defaults, close, recovery, and project-switch rules
- [ ] keep dormant window state out of current layouts

### Batch 17.2 — Surface-Free Transfer

- [ ] Execute card 052.
- [ ] compose sessions, complete leases, geometry, and authoritative moves
- [ ] retain panel bodies and resource bindings in Nucleus

### Batch 17.3 — Native Acceptance

- [ ] Execute card 053.
- [ ] prove drag, stale targets, display changes, restart, close, and rollback
- [ ] audit exact absence of hosted Surface state

## Acceptance Criteria

- [ ] the primary-window workflow is unchanged until a secondary window exists
- [ ] only allowed movable panels can transfer
- [ ] stale or incomplete target leases cannot mutate layouts
- [ ] panel identity and product attachments survive the move
- [ ] Nucleus still has no hosted Surface dependency

## Batch Cards

- `batch-cards/051-secondary-window-product-gate.md` — paused
- `batch-cards/052-surface-free-panel-transfer.md` — paused behind card 051
- `batch-cards/053-secondary-window-native-acceptance.md` — paused behind card 052

## Resume Condition

The operator selects a real secondary-window workflow. Infrastructure interest
alone is not enough to start this lane.
