# 223 Change Request Prep Type Split

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../051-change-request-prep-module-split.md`

## Purpose

Split change-request prep production types into focused modules.

## Scope

- Separate prep records, targets, candidates, policy gates, descriptors, and
  evidence packages where useful.
- Preserve provider-neutral vocabulary and public re-exports.

## Acceptance Criteria

- `change_request_prep.rs` becomes a module front door or smaller file.
- Existing public imports still compile.

## Validation

- `cargo test -p nucleus-engine change_request`
- `cargo check --workspace`

## Stop Conditions

- Stop if the split would alter forge or SCM authority semantics.
