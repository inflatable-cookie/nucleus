# 091 Workspace Display Window Types

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Add display and window identity/placement types to `nucleus-workspaces`.

## Work

- [x] Add display ids, display records, arrangement signatures, bounds, and
  availability hints.
- [x] Add stable window ids distinct from native host handles.
- [x] Add window placement config with target display, fallback displays, and
  per-display geometry.
- [x] Add module-level docs explaining local client profile authority.
- [x] Add focused construction/equality tests where useful.

## Acceptance Criteria

- [x] `nucleus-workspaces` no longer models workspace layout as only project
  panels and surfaces.
- [x] Native host handles are not persisted identity.
- [x] Display/window state is clearly local client profile state.

## Result

Added focused `nucleus-workspaces` modules:

- `geometry.rs` for bounds and window geometry
- `displays.rs` for local display inventory and availability
- `windows.rs` for stable workspace window config and runtime host window
  instances

Updated `ids.rs` with display, window, window-instance, host-window, client
profile, and arrangement signature ids. Host window ids are runtime-local and
separate from persisted workspace window ids.

## Validation

- `cargo fmt --all`
- `cargo test -p nucleus-workspaces`
- `cargo check -p nucleus-workspaces`
