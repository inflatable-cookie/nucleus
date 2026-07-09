# 114 Desktop Surface Tabs And Regions

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../024-workspace-surface-shell-skeleton.md`

## Purpose

Render the first surface shell inside the normal desktop product workspace.

## Work

- [x] Add a Svelte workspace UI config client.
- [x] Replace the blank workspace stage with a Poodle `Tabs` block-variant
  surface strip.
- [x] Add create, rename, remove, and select surface interactions.
- [x] Render the fixed region vocabulary with Poodle `DockRegion`.
- [x] Keep panel contents as skeletons only.
- [x] Remove the extra right rail outside the surface model.

## Acceptance Criteria

- [x] Normal workspace is no longer blank.
- [x] Proof harness remains isolated behind the header icon button.
- [x] The normal workspace does not render task workflow content.
- [x] The right region belongs to the active surface.
- [x] Surface tabs, dock tabs, labels, buttons, surfaces, and text use Poodle
  components rather than custom widgets.
