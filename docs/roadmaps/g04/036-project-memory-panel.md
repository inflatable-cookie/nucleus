# 036 Project Memory Panel

Status: completed
Updated: 2026-07-15
Owner: Tom
Updated: 2026-07-14

## Purpose

Replace the undefined Context placeholder with a compact project Memory panel
over existing accepted-memory and memory-proposal read models.

## Governing Refs

- `../../contracts/013-shared-memory-contract.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../architecture/system-architecture.md`

## Execution Plan

- [x] Migrate the local panel kind, launcher, defaults, and persisted Context
  instances to Memory.
- [x] Add the missing accepted-memory desktop adapter and render accepted and
  proposed summaries in one minimal project panel.
- [x] Validate migration, read-only authority, responsive panel behavior, and
  operator interaction before considering review controls.

## Goals

- [x] Existing Context tabs become Memory without losing placement.
- [x] Accepted memory and proposals are visibly distinct.
- [x] The panel stays useful in narrow or wide workspace regions.
- [x] No memory mutation or invented content enters the client.

## Acceptance Criteria

- [x] The `+` menu creates Memory panels and no longer offers Context.
- [x] Existing persisted `context` panels normalize to `memory` and retain
  their region/order.
- [x] Project selection loads sanitized accepted-memory and proposal summaries.
- [x] Loading, empty, and failure states are explicit.
- [x] Desktop checks, focused Rust guards, docs QA, and operator review pass.

## Batch Cards

Completed:

- `batch-cards/180-context-to-memory-migration.md`
- `batch-cards/181-read-only-memory-panel.md`
- `batch-cards/182-memory-panel-validation.md`
