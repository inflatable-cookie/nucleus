# 004 Forge Working-Copy Controls

Status: active
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
- [ ] Validate the native workflow and compact interaction shape.

## Acceptance Criteria

- [x] a path with staged and working changes appears in both groups
- [x] status fingerprints prevent mutations from stale UI state
- [x] Stage and Unstage are authority-host actions with durable receipts
- [x] commit captures only staged content and returns a sanitized receipt
- [x] hooks, signing, prompts, automatic staging, push, discard, task mutation,
  and forge effects remain blocked
- [ ] operator confirms the Forge interaction remains visually sparse

## Batch Cards

Completed:

- `batch-cards/011-working-copy-observation-and-scoped-diffs.md`
- `batch-cards/012-index-staging-controls.md`
- `batch-cards/013-local-commit-control.md`
