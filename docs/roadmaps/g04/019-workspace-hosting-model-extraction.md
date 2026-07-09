# 019 Workspace Hosting Model Extraction

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Promote the recorded Loophole-inspired display/window/surface/region/panel
model into `nucleus-workspaces` before serious product shell implementation.

This lane makes the selected-task product shell sit inside the right hosting
model instead of hardcoding one disposable desktop layout.

## Governing Refs

- `docs/specs/004-display-window-surface-layout.md`
- `docs/contracts/006-workspace-layout-contract.md`
- `docs/architecture/product-workflow-ui-architecture.md`
- `../loophole/echo/crates/echo-windowing`
- `../loophole/echo/crates/echo-ui-layout`

## Goals

- [x] Inspect the current Loophole Echo windowing/layout source and identify
  the minimum transferable subset.
- [x] Add `nucleus-workspaces` display, window, and hosted surface modules in
  small files.
- [x] Add `nucleus-workspaces` region and panel adaptation modules in small
  files.
- [x] Add deterministic planning/fallback helpers and focused tests.
- [x] Represent local client profile authority without committing layout state
  into project management files.
- [x] Defer Aura configuration UI until Rust shape and storage authority are
  stable.

## Execution Plan

- [x] Batch 1: Echo source audit and Nucleus port map.
- [x] Batch 2: display/window identity and placement records.
- [x] Batch 3: window planning and display fallback helpers.
- [x] Batch 4: hosted surface records and active-surface fallback.
- [x] Batch 5: region/panel rule boundary and project adaptation shape.
- [x] Batch 6: local client profile persistence boundary.
- [x] Batch 7: validation and next lane selection.

## Batch Cards

Completed cards:

- `batch-cards/090-echo-windowing-port-map.md`
- `batch-cards/091-workspace-display-window-types.md`
- `batch-cards/092-window-planning-fallback-helpers.md`
- `batch-cards/093-hosted-surface-lifecycle-model.md`
- `batch-cards/094-region-panel-project-adaptation-boundary.md`
- `batch-cards/095-local-layout-persistence-boundary.md`
- `batch-cards/096-workspace-hosting-validation-next-lane.md`

## Boundary

This lane may:

- add pure Rust types and helpers in `nucleus-workspaces`
- add focused unit tests for planning and fallback semantics
- update architecture/contracts if implementation reveals needed precision
- add read-only fixture or diagnostic shape where it clarifies the model

This lane must not:

- port Aura's full configuration UI
- implement final product shell visuals
- store layout in committable project projection files
- add terminal, browser, editor, or SCM process behavior
- make the Svelte renderer the layout authority

## Decision Notes

Nucleus should start with one native window and one hosted surface if needed,
but identity, placement, and fallback must already be modeled as if multiple
windows and hosted surfaces can exist.

The implementation should prefer a local Nucleus module shape over a direct
copy if it keeps the crate clearer. Extracting a shared crate can happen later
if Loophole and Nucleus both need one maintained implementation.

The next selected lane is selected-task product aggregate query. The product
shell should consume one product-facing read model before final UI layout work
resumes.

## Port Map

Use from `echo-windowing`:

- display, window, window-instance, and host-window identity split
- display arrangement signature
- window bounds and per-display geometry
- window placement config with target display and fallback displays
- deterministic display selection
- window plan input/output and primary-window selection
- shell hosting resolver shape
- hosted-surface lifecycle mutations
- restore normalization and active-surface fallback semantics

Adapt from `echo-ui-layout`:

- machine workspace policy as local client profile shell policy
- participating display set
- surface-to-window mapping
- user/project override layering
- stable panel ordering within spaces
- bounds clamping against display geometry
- resolved window with hosted surfaces and panels

Defer from Loophole:

- DAW panel catalogue and labels
- DAW-specific regions such as transport/timeline/clip editor defaults
- Aura drag/drop and configuration screens
- Electron-specific host behavior
- legacy IPC codec compatibility layers

Initial Nucleus module map:

- `ids.rs`: shared layout ids plus display/window/host identifiers
- `geometry.rs`: bounds, display geometry, arrangement signatures
- `displays.rs`: display inventory records and availability hints
- `windows.rs`: window config, host roles, placement, host handles
- `planning.rs`: pure display/window planning helpers
- `hosted_surfaces.rs`: hosted surface records, ordering, active fallback
- `regions.rs`: Nucleus region ids and region metadata
- `panels.rs`: project panel rules below hosted surfaces
- `layout.rs`: local client profile shell and per-project panel layout records
