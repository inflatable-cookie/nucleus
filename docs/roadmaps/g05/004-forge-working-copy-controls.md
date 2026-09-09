# 004 Forge Working-Copy Controls

Status: completed
Owner: Tom
Updated: 2026-07-27

## Purpose

Turn the Forge inventory into a compact local working-copy workflow without
expanding into a full Git client.

## Governing Refs

- `../../contracts/011-scm-forge-sync-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/017-engine-host-authority-contract.md`

## Execution Plan

- [x] Add live working-copy status and scoped staged or working diffs.
- [x] Add exact-path and repository-group Stage or Unstage controls.
- [x] Add an explicit local commit composer over the staged index.
- [x] Validate the native workflow and compact interaction shape.

## Acceptance Criteria

- [x] a path with staged and working changes appears in both groups
- [x] status fingerprints prevent mutations from stale UI state
- [x] Stage and Unstage are authority-host actions with durable receipts
- [x] commit captures only staged content and returns a sanitized receipt
- [x] hooks, signing, prompts, automatic staging, push, discard, task mutation,
  and forge effects remain blocked
- [x] operator confirms the Forge interaction remains visually sparse

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.



- `011-working-copy-observation-and-scoped-diffs.md` — completed (collapsed into this task)
- `012-index-staging-controls.md` — completed (collapsed into this task)
- `013-local-commit-control.md` — completed (collapsed into this task)
