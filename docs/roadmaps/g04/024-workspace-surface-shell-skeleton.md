# 024 Workspace Surface Shell Skeleton

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Install the first Loophole-style surface shell in the desktop product UI
without building final task workflow screens.

This lane proves:

- local workspace UI config writes to `~/.nucleus/config/ui.json`
- the desktop can load/save surface state through Tauri commands
- the product workspace has a Poodle `Tabs` block-variant surface strip
- surfaces can be created, renamed, removed, and selected
- each surface renders the agreed regions: `left`, `right`, `centerTop`,
  `centerBottom`
- panels carry an explicit allowed-region placement policy
- closeable panels can be recreated from the top-level `+` menu
- region split ratios are resizable and persisted as local UI state
- panel tabs can be dragged between allowed regions with visible drop targets
- empty regions collapse until they contain panels or become valid drop targets
- the full-height project rail is resizable as local client shell state

## Boundary

This lane may:

- add local desktop UI config DTOs
- persist local client UI state below `~/.nucleus`
- render panel skeletons for chat, tasks, terminal, and context using Poodle
  `DockRegion`, `Surface`, and `Text`
- remove old proof/product rail clutter from the normal workspace

This lane must not:

- add final task workflow controls
- make the task panel the primary interface
- add arbitrary split-tree layout
- commit UI layout into project repositories
- treat the Svelte proof shell as final product design

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/116-product-workflow-ui-design-review.md`
- `batch-cards/113-local-workspace-ui-config-boundary.md`
- `batch-cards/114-desktop-surface-tabs-and-regions.md`
- `batch-cards/115-workspace-surface-shell-validation.md`
- `batch-cards/117-surface-panel-placement-policy-feedback.md`
- `batch-cards/118-surface-panel-placement-validation.md`
- `batch-cards/119-panel-recovery-menu-and-resizable-regions.md`
- `batch-cards/120-panel-cross-region-drag-drop-hardening.md`
- `batch-cards/121-empty-region-collapse-and-drop-target-reveal.md`
- `batch-cards/122-project-rail-resizable-shell-split.md`
