# 028 Initial Code Editor Vertical Slice

Status: active
Owner: Tom
Updated: 2026-07-10

## Purpose

Turn the existing Editor placeholder into a real host-authorized CodeMirror 6
workspace without importing an IDE shell.

## Generation Runway Fit

This lane advances G04 from agent-driven task execution into a product-shaped
workspace where the operator can inspect and adjust real project files. It
keeps the client as renderer and intent source while proving the Rust host file
boundary needed by later evidence, diff, review, and language-service work.

## Governing Refs

- `../../research/translation-memos/editor-substrate-selection.md`
- `../../specs/006-initial-code-editor-vertical-slice.md`
- `../../architecture/system-architecture.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/007-server-boundary-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`

## Goals

- [ ] Prove project-scoped file discovery, snapshot read, and revision-checked
  save through Rust authority.
- [ ] Embed official CodeMirror 6 packages through a thin Nucleus Svelte
  adapter.
- [ ] Deliver a simple one-buffer open-edit-save workflow in the existing
  Editor panel.
- [ ] Add quick open, initial language presentation, token-based styling, and
  explicit dirty/reload/conflict handling.
- [ ] Validate the real Tauri workflow and select the next editor/review lane.

## Boundary

This lane may:

- add typed editor file refs, snapshots, discovery results, and save commands
- add project-root containment, text/size/ignore policy, revisions, and safe
  replacement
- add CodeMirror packages and a Nucleus-owned Svelte adapter
- replace the Editor placeholder with one active buffer
- add quick open, Save, reload, dirty indication, read-only state, syntax
  presentation, and conflict handling

This lane must not:

- add a permanent file explorer, editor-internal tab system, minimap, outline,
  command centre, or IDE shell
- add LSP processes, completion, diagnostics, formatting, rename, code actions,
  debugging, plugins, or VS Code compatibility
- add autosave, hot-exit recovery, file watchers, or durable editor view state
- let Svelte discover, read, or write project files directly
- let stale save overwrite current host content

## Execution Plan

- [x] Batch 1: host-authorized editor file discovery/read/save boundary and
  serialized control transport.
- [x] Batch 2: direct CodeMirror adapter and real one-buffer Editor panel
  integration.
- [x] Batch 3: quick open, language registry, Poodle-token theme, dirty switch,
  reload, and conflict-state completion.
- [ ] Batch 4: end-to-end validation, evidence closeout, and next-lane
  checkpoint.

## Acceptance Criteria

- [ ] A repository text file can be found, opened, edited, saved, and reopened
  through the proper interface.
- [ ] Out-of-project, ignored, binary, oversized, read-only, and stale write
  cases fail explicitly through Rust policy.
- [ ] A rejected save preserves the dirty client buffer.
- [ ] The editor mounts, resizes, closes, and reopens without leaked state or
  duplicate handlers.
- [ ] Normal presentation remains one quiet editor surface with advanced
  behavior absent or behind compact controls.
- [ ] Rust, desktop, documentation, interaction, and conflict smokes pass.

## Planning Gaps Beyond This Lane

- file watchers and hot-exit recovery
- multiple buffer identity and restoration
- exact server-owned LSP transport and CodeMirror capability adapters
- VS Code-compatible theme translation
- editor-to-diff/review and agent evidence navigation

These gaps do not block the first explicit one-buffer workflow.

## Batch Cards

Ready:

- `batch-cards/153-editor-validation-and-next-lane-checkpoint.md`

Planned:

- None.

Completed:

- `batch-cards/150-editor-file-authority-and-control-boundary.md`
- `batch-cards/151-codemirror-editor-panel-vertical-slice.md`
- `batch-cards/152-editor-quick-open-language-theme-and-conflicts.md`

## Checkpoint

After card 153, stop for operator review of the working editor and select
between diff/review integration, multiple buffers, file watching/recovery, or
the first server-owned language-service lane.
