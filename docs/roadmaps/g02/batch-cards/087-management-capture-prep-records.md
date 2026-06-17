# 087 Management Capture Prep Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../021-management-projection-sync-runtime.md`

## Purpose

Create management capture preparation records from accepted sync assistance.

## Scope

- Represent capture prep scope, files, evidence, receipts, and approval state.
- Keep capture execution provider-neutral.
- Do not create commits, snapshots, publications, or pushes.

## Acceptance Criteria

- Capture prep is separate from capture execution.
- Capture prep can cite projection files and receipts.
- Provider-specific authority transitions remain out of scope.

## Validation

- `cargo test -p nucleus-engine management_projection`
- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if capture prep needs provider credentials.
