# 034 Four Main Region Workspace Grid

Status: active
Owner: Tom
Updated: 2026-07-14

## Purpose

Turn the main workspace into a fixed two-column by two-row grid and let every
workspace tab move between all four main regions.

## Governing Refs

- `../../specs/011-four-main-region-workspace-grid.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`

## Execution Plan

- [x] Promote the five-region vocabulary and universal main-region placement.
- [x] Migrate local config and the Rust region model.
- [x] Render the right vertical split and expose all four main drop targets.
- [ ] Validate persistence, desktop behavior, docs, and operator layout.

## Batch Cards

Ready:

- `batch-cards/176-four-main-region-validation-checkpoint.md`

Completed:

- `batch-cards/174-four-main-region-schema-and-model.md`
- `batch-cards/175-four-main-region-desktop-layout.md`
