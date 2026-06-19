# 219 Engine Management Sync Validation

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../049-engine-management-sync-test-split.md`

## Purpose

Validate the engine management sync test split.

## Scope

- Run scoped engine tests.
- Check god-file report for the touched test file.
- Advance to server apply/import split.

## Acceptance Criteria

- Scoped engine tests pass.
- The original management sync test file is no longer an error finding.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo check --workspace`
- `effigy doctor`
- `git diff --check`

## Stop Conditions

- Stop if management sync assertions changed.

## Result

`cargo test -p nucleus-engine management_sync` and `cargo check --workspace`
pass. `effigy doctor` god-file errors dropped from three to two.
