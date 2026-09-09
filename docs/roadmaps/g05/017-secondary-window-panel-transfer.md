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

### Product Gate (paused)

- [ ] define one useful secondary-window workflow after the operator selects a concrete use case
- [ ] contract window role, project behavior, defaults, close, restart, and recovery
- [ ] keep movable and fixed panel classes explicit
- [ ] keep dormant window state out of current layouts

### Surface-Free Transfer (paused behind the product gate)

- [ ] compose sessions, complete measured target leases, geometry, and authoritative moves
- [ ] move panels through authoritative layout mutation
- [ ] retain panel bodies and resource bindings in Nucleus

### Native Acceptance (paused behind transfer)

- [ ] prove drag, stale targets, display changes, restart, close, and rollback
- [ ] audit exact absence of hosted Surface state

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09): `051-secondary-window-product-gate.md`, `052-surface-free-panel-transfer.md`, and `053-secondary-window-native-acceptance.md`, all paused and absorbed above. Dispatch evidence lives in `../dispatch.md`.

## Stop Conditions

- infrastructure interest alone is not product authority

## Resume Condition

The operator selects a real secondary-window workflow. Infrastructure interest
alone is not enough to start this lane.
