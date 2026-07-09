# 095 Local Layout Persistence Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Specify the local client profile persistence boundary for workspace hosting.

## Work

- [x] Identify record families for global shell layout and per-project panel
  layout.
- [x] Define which records belong in local SQLite/client profile storage.
- [x] Define which records must not enter repo-backed management projection.
- [x] Decide whether this lane needs storage codecs now or only type shape.
- [x] Update the storage contract if implementation clarifies the schema.

## Acceptance Criteria

- [x] Layout persistence does not conflict with committable project metadata.
- [x] Global display/window/surface records are separated from per-project
  panel layout records.
- [x] A later storage implementation can proceed without re-deciding
  authority.

## Result

Added `local_layout.rs` with:

- `LocalLayoutRecordKind`
- `LocalLayoutPersistenceScope`
- `GlobalShellLayoutRecord`
- `ProjectPanelLayoutRecord`
- `LocalLayoutRecord`

The first implementation is type shape only. SQLite codecs, migrations,
conflict handling, sync, and projection export remain out of scope. Both
global shell layout and per-project panel layout are local client profile
records and are not allowed in repo-backed management projection.

Updated the storage and workspace layout contracts to reflect current Rust
coverage.

## Validation

- `cargo fmt --all`
- `cargo test -p nucleus-workspaces`
- `cargo check -p nucleus-workspaces`
