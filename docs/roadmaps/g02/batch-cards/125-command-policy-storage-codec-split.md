# 125 Command Policy Storage Codec Split

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Split the command-policy storage codec god-file into focused Rust modules.

## Scope

- Keep public behavior stable.
- Use `lib.rs` and module files as crate front doors.
- Split record types, encode/decode helpers, and tests where appropriate.
- Avoid broad command-policy redesign.

## Acceptance Criteria

- `scan.god-files` no longer reports the high command-policy finding.
- Existing command-policy tests pass.
- Module names explain their responsibilities.

## Validation

- `cargo test -p nucleus-command-policy`
- `effigy doctor`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the split needs a storage format change.
