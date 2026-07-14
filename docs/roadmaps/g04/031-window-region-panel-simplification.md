# 031 Window Region Panel Simplification

Status: completed
Owner: Tom
Updated: 2026-07-13

## Purpose

Remove the disproven hosted-Surface layer while preserving the working product
panel workflow and multi-window foundation.

## Governing Refs

- `../../specs/archive/008-window-region-panel-simplification.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/008-storage-state-persistence-contract.md`

## Goals

- [x] Persist direct window layout instead of active Surface inventory.
- [x] Remove Surface tabs and lifecycle controls from the product shell.
- [x] Move Rust panel placement from Surface ids to Window ids.
- [x] Preserve existing panel workflows and local-only authority.

## Execution Plan

- [x] Batch 1: canonical model promotion and stale-authority cleanup.
- [x] Batch 2: desktop config and workspace-stage flattening.
- [x] Batch 3: Rust workspace model simplification.
- [x] Batch 4: regression validation and closeout.

## Boundary

This lane may break the pre-1.0 `ui.json` schema, selecting the old active
Surface as migration input. It may delete hosted-Surface Rust types and remove
Surface UI controls.

It must not alter Poodle visual primitives, add native multi-window behavior,
add arbitrary split trees, change project/task authority, or redesign working
panels.

## Acceptance Criteria

- [x] Normal workspace has no Surface tab strip or Surface action controls.
- [x] Config owns one direct layout/region set and normalizes panel policy.
- [x] Panel creation, close, reorder, cross-region move, and resize persist.
- [x] Rust hierarchy contains no hosted-Surface identity or lifecycle model.
- [x] Existing product panel checks and builds pass.

## Batch Cards

Ready:

- None.

Planned:

- None.

Completed:

- `batch-cards/162-window-panel-model-promotion.md`
- `batch-cards/163-desktop-window-layout-flattening.md`
- `batch-cards/164-rust-workspace-model-simplification.md`
- `batch-cards/165-layout-simplification-validation-closeout.md`

## Checkpoint

The code and docs lane is complete. Stop for live operator inspection before
selecting task completion, Goal-wide rework policy, or another workflow gap.
