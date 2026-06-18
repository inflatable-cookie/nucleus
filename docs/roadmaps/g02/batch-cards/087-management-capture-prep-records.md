# 087 Management Capture Prep Records

Status: completed
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

- [x] Capture prep is separate from capture execution.
- [x] Capture prep can cite projection files and receipts.
- [x] Provider-specific authority transitions remain out of scope.

## Outcome

- Added management capture preparation records built from sync plans.
- Kept capture preparation separate from SCM commits, snapshots,
  publications, pushes, and gates.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if capture prep needs provider credentials.
