# 151 CodeMirror Editor Panel Vertical Slice

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../028-initial-code-editor-vertical-slice.md`
Auto-start next card: yes

## Objective

Replace the existing Editor placeholder with one real CodeMirror 6 buffer that
opens, edits, and saves through the card 150 Rust boundary.

## Governing Refs

- `../../../architecture/product-workflow-ui-architecture.md`
- `../../../contracts/006-workspace-layout-contract.md`
- `../../../specs/006-initial-code-editor-vertical-slice.md`
- `../../../research/translation-memos/editor-substrate-selection.md`
- `150-editor-file-authority-and-control-boundary.md`

## Scope

- install official CodeMirror 6 packages directly; no community Svelte wrapper
- add a thin Nucleus Svelte adapter that owns `EditorView` lifecycle
- mount the adapter in the existing Editor panel/tab path without changing the
  shell or panel inventory
- support one active snapshot, local dirty state, undo/redo, search, selection,
  line numbers, bracket matching, folding, and keyboard Save
- wire open/read/save to the typed desktop control helper
- show compact path, dirty, Save, loading, empty, read-only, error, and basic
  save-conflict states
- dispose editor state and handlers on buffer replacement and panel unmount

## Ordered Steps

1. Add the minimum official CodeMirror dependencies and lockfile changes.
2. Build the Nucleus-owned editor adapter with explicit create, reconfigure,
   document-change, focus, and destroy behavior.
3. Add typed client helpers for discovery, read, and save responses.
4. Replace the Editor placeholder with a one-buffer panel using the current
   visual density and controls.
5. Wire Save and platform save shortcut to the exact snapshot revision.
6. Preserve dirty content on refusal, conflict, and transient failure.
7. Add component guards and focused interaction coverage for lifecycle and
   open-edit-save behavior.

## Acceptance Criteria

- opening an admitted file renders its real content in CodeMirror
- editing marks the buffer dirty without mutating host state
- Save writes through Rust and clears dirty only after an accepted snapshot
- undo/redo, search, keyboard Save, resizing, and focus work in the panel
- conflict/error keeps the dirty buffer intact and visible
- closing/reopening does not duplicate listeners or reuse stale editor state
- no explorer, minimap, LSP, formatter, plugin, or editor tab system appears

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `effigy test -- --package nucleus-desktop --package nucleus-server`
- `git diff --check`

## Closure Evidence

- real Tauri open-edit-save smoke on a disposable repository file
- adapter lifecycle test or guard covering destroy/reopen
- screenshot or visual inspection at normal and constrained panel widths
- package inventory limited to official CodeMirror modules

## Stop Conditions

- CodeMirror requires a wrapper-owned state model or shell rewrite
- the panel cannot resize inside the current hosted region
- editor changes bypass Rust save authority
- accepted save and dirty-state convergence cannot be made deterministic

## Next

Auto-start card 152 after this card closes. Stop instead if visual review shows
the one-buffer panel needs a product decision beyond the promoted simple shape.

## Outcome

- official CodeMirror 6 packages are installed directly
- a thin Nucleus Svelte adapter owns `EditorView` create/destroy, changes, and
  platform Save shortcut
- the existing Editor panel now opens admitted project files, edits locally,
  tracks dirty state, and saves through Rust authority
- basic setup supplies history, search, selection, line numbers, bracket
  matching, and folding without IDE chrome
- rejected and stale saves leave the dirty buffer intact
- production desktop build passes; desktop type checking remains blocked only
  by the pre-existing Poodle `ToastHost.svelte` optional-tone error
