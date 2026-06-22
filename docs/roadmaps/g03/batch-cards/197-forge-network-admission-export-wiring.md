# 197 Forge Network Admission Export Wiring

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../056-stopped-provider-auth-forge-admission-records.md`

## Purpose

Expose the stopped admission module through the server crate front door.

## Acceptance Criteria

- [x] `lib.rs` declares the module.
- [x] `exports.rs` re-exports the module surface.
- [x] `cargo check -p nucleus-server` passes.

## Validation

- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
