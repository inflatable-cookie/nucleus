# 021 Convergence Runner Replay Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Add storage-backed replay records for Convergence stopped runner decisions
before any real Convergence backend effect is enabled.

## Governing Refs

- `docs/roadmaps/g03/020-convergence-backend-surface-research.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist stopped runner adapter decisions with stable replay ids.
- [x] Preserve Convergence backend refs without storing raw provider payloads.
- [x] Add read-only replay diagnostics for ready, blocked, duplicate, and
  unsupported effect families.
- [x] Keep every Convergence backend effect disabled by default.

## Execution Plan

- [x] Replay record batch.
- [x] Replay diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/076-convergence-runner-replay-records.md`
- `batch-cards/077-convergence-runner-replay-diagnostics.md`
- `batch-cards/078-convergence-runner-replay-closeout.md`

## Acceptance Criteria

- [x] Replay records derive from stopped command-adapter records, not live
  backend calls.
- [x] Replay records preserve snap/publication/bundle/promotion/release-shaped
  refs as optional provider refs without assuming they all exist yet.
- [x] Duplicate replay ids are deterministic no-ops.
- [x] No object upload, publication, lane sync, bundle, approval, promotion,
  release, resolution publication, provider write, task mutation, callback,
  interruption, recovery, or raw-output effect is added.
