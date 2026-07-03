# 506 Nucleus Planning Crate Front Door

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Add a focused `nucleus-planning` crate and keep it modular from the start.

## Work

- [x] Add the crate to the workspace.
- [x] Add a small `lib.rs` that only acts as a front door and module index.
- [x] Add named modules for ids, sessions, exploration, artifacts, refs, and
  storage shape as needed.
- [x] Avoid moving existing server/engine task-seed behavior until the boundary
  is proven.

## Acceptance Criteria

- [x] `cargo check --workspace` passes.
- [x] Planning-domain code is not dumped into `lib.rs`.
- [x] The crate does not introduce server, UI, provider, SCM, or storage
  effects.

## Evidence

- Added `crates/nucleus-planning`.
- Added workspace member in root `Cargo.toml`.
- Added focused modules: `ids`, `sessions`, `exploration`, `artifacts`, `refs`,
  and `storage_shape`.
- `cargo fmt --check` passed.
- `cargo check --workspace` passed.
