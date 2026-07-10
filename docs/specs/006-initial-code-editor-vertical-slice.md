# Initial Code Editor Vertical Slice

Status: promoted-first-pass
Owner: Tom
Updated: 2026-07-10

## Purpose

Turn the existing Editor placeholder into a real Nucleus workspace surface
without importing a full IDE shell or weakening Rust host authority.

## Target Operating Model

The operator opens one project file through quick open, edits it in CodeMirror
6, and saves through a revision-checked Rust host command. The panel stays
compact and uses the current Nucleus/Poodle visual language.

CodeMirror owns the live browser editing state. The Rust host owns project-root
resolution, file discovery, opaque file identity, snapshots, content revisions,
write policy, conflict admission, safe replacement, and future language-server
processes.

## Goals

- [ ] One real project file can be discovered, opened, edited, and saved.
- [ ] A stale save is refused without losing the dirty client buffer.
- [ ] The Editor panel remains visually simple and uses quick open instead of a
  permanent file explorer.
- [ ] CodeMirror integration is thin, direct, disposable, and independent of a
  community Svelte wrapper.
- [ ] Syntax presentation and editor styling fit current project files and
  Poodle tokens.
- [ ] The boundary leaves a clean later path to diagnostics, completion, merge,
  language servers, and richer buffer management.

## Non-Goals

- VS Code workbench or extension compatibility
- language-server process launch or LSP feature delivery
- editor-internal multi-buffer tabs
- permanent file tree, outline, minimap, breadcrumbs stack, or command centre
- autosave, hot-exit restoration, durable cursor/scroll state, or file watchers
- formatter, rename, code action, debugging, terminal, SCM, or plugin controls
- binary or oversized file editing

## Artifact Set

- editor substrate translation memo
- workspace architecture and contract promotion
- host-authorized file discovery/read/save boundary
- serialized control request/response shapes
- desktop CodeMirror adapter and Editor panel integration
- quick-open, language registry, theme, dirty, reload, and conflict states
- validation and next-lane checkpoint

## Delivery Phases

### Host file authority

- resolve files only inside the selected project root
- return safe relative paths and opaque file refs
- classify text/binary and enforce size and ignore policy
- derive an opaque content revision from the accepted snapshot
- reject stale or unauthorized saves
- return the new snapshot after a safe replacement

### Editor integration

- install official CodeMirror 6 packages directly
- mount and destroy one `EditorView` through a Nucleus Svelte adapter
- wire document changes to local dirty state
- wire Save and platform save shortcut to the host command
- preserve the dirty buffer across save conflict or transient failure

### Product completion

- add quick open as a compact popover
- add the initial language registry and syntax presentation
- style the editor from current tokens
- handle dirty file replacement, reload, empty, loading, read-only, conflict,
  and error states
- validate real repository editing in the Tauri app

## Validation Strategy

- Rust unit tests for path admission, ignore/size/text policy, revision changes,
  stale conflicts, safe save, and serialized round trips
- Svelte/TypeScript checks for adapter and panel state
- desktop build validation
- focused interaction smoke: quick open, edit, undo/redo, search, save, reopen
- stale revision smoke that proves the dirty buffer survives refusal
- visual review at normal and constrained panel sizes

## Stop Conditions

- safe project-root containment cannot be established without a broader host
  authority change
- save can overwrite a stale or externally changed snapshot
- CodeMirror lifecycle leaks state or handlers across panel close/reopen
- the implementation requires a permanent explorer or IDE chrome to be usable
- language-server, plugin, or VS Code compatibility work enters the first slice
- the panel bypasses the Rust boundary for discovery, read, or save

## Promoted Authority

Durable decisions live in:

- `docs/architecture/system-architecture.md`
- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/006-workspace-layout-contract.md`

Execution is sequenced by:

- `docs/roadmaps/g04/028-initial-code-editor-vertical-slice.md`
