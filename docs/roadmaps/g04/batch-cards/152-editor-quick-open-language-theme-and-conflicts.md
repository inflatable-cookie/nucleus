# 152 Editor Quick Open Language Theme And Conflicts

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../028-initial-code-editor-vertical-slice.md`
Auto-start next card: yes

## Objective

Complete the first editor workflow with compact discovery, useful syntax
presentation, Nucleus styling, and explicit dirty/reload/conflict behavior.

## Governing Refs

- `../../../architecture/product-workflow-ui-architecture.md`
- `../../../contracts/006-workspace-layout-contract.md`
- `../../../specs/006-initial-code-editor-vertical-slice.md`
- `151-codemirror-editor-panel-vertical-slice.md`

## Scope

- add a compact quick-open popover over the host discovery query
- add a small language registry keyed by host language hint for current repo
  file types
- add CodeMirror theme extensions derived from Nucleus/Poodle tokens
- make dirty file switching require Save, Discard, or Cancel
- add explicit reload and stale conflict presentation while preserving edits
- finish empty, loading, read-only, unsupported, oversized, conflict, and error
  states without permanent chrome
- keep advanced file metadata and recovery actions in the overflow/popover

## Ordered Steps

1. Build quick-open filtering and keyboard interaction on host results.
2. Add lazy language-support mapping for the repository types used in the
   validation fixture.
3. Add token-derived editor, gutter, selection, search, and syntax styling.
4. Add Save/Discard/Cancel admission before replacing a dirty buffer.
5. Add Reload and stale conflict controls without silent overwrite or reload.
6. Exercise narrow panel, long path, empty result, and read-only presentation.
7. Add focused component and interaction guards for the completed states.

## Acceptance Criteria

- quick open finds admitted files without adding a permanent explorer
- language selection follows the host hint and falls back to plain text
- editor styling belongs to Nucleus rather than resembling a VS Code clone
- dirty switching never loses content without explicit operator choice
- stale conflict offers reload or keep editing and never overwrites silently
- advanced states stay compact and do not crowd the normal editor
- all first-slice states remain keyboard accessible

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- focused desktop tests for quick open, dirty switching, language fallback, and
  conflict controls
- `git diff --check`

## Closure Evidence

- interaction smoke covering quick open, syntax, edit, save, dirty switch,
  stale conflict, keep editing, reload, and reopen
- visual inspection at normal and constrained widths
- no permanent explorer, tab maze, minimap, or LSP/plugin control introduced

## Stop Conditions

- the initial language set requires community packages with unclear ownership
  or incompatible licensing
- quick open needs client filesystem traversal
- conflict resolution begins implementing merge or SCM behavior
- the UI needs an unapproved persistent sidebar or editor tab system

## Next

Auto-start card 153 after the first-slice interaction is complete.

## Outcome

- the provisional selector is replaced by one keyboard-accessible quick-open
  popover over the host-admitted file inventory
- the active file lazily loads official Rust, JavaScript/TypeScript, JSON,
  HTML, CSS, or Markdown support and otherwise stays plain text
- CodeMirror editor, gutter, selection, search, and syntax presentation now
  derive from Nucleus/Poodle tokens
- dirty file replacement requires explicit Save and open, Discard, or Cancel
- stale save conflicts retain the buffer and offer explicit Reload disk or
  Keep editing actions
- read-only, loading, empty, plain-text, and error states remain compact; no
  explorer, tabs, minimap, LSP, plugin, merge, or client filesystem path was
  introduced
- desktop build, type checking, four focused editor-support tests, and diff
  checks pass; native visual and full interaction evidence remains card 153
