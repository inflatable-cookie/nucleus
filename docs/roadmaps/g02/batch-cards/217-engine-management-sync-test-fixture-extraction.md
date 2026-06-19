# 217 Engine Management Sync Test Fixture Extraction

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../049-engine-management-sync-test-split.md`

## Purpose

Extract shared fixtures from engine management sync tests.

## Scope

- Move common builders into focused test helpers.
- Preserve management sync assertions.

## Acceptance Criteria

- Shared builders are isolated.
- Existing management sync tests still pass.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo check --workspace`

## Stop Conditions

- Stop if fixtures encode behavior that should move to production types.

## Result

Common management sync test helpers now live in the test index.
