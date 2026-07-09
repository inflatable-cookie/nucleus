# 094 Region Panel Project Adaptation Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Define the first region/panel rule boundary for adapting a project into the
global hosted surface arrangement.

## Work

- [x] Add region ids suitable for Nucleus' dev environment shell.
- [x] Separate global hosted surfaces from per-project panel rules.
- [x] Define project panel placement records without committing layout state.
- [x] Preserve existing panel/surface types or migrate them cleanly.
- [x] Add tests for project rules resolving into a hosted surface skeleton.

## Acceptance Criteria

- [x] Panel layout is per-project local state.
- [x] Global surface/window arrangement remains client-profile state.
- [x] The selected-task product shell can be represented as project panel
  rules, not a special top-level layout authority.

## Result

Added:

- `regions.rs` with Nucleus region ids and definitions.
- `project_panels.rs` with per-project panel placement rules, selected-task
  shell seed rules, and resolution against available hosted surfaces.

The selected-task shell is now representable as project panel rules below a
hosted surface. Missing hosted surfaces skip project panels rather than
inventing global shell state.

## Validation

- `cargo fmt --all`
- `cargo test -p nucleus-workspaces`
- `cargo check -p nucleus-workspaces`
