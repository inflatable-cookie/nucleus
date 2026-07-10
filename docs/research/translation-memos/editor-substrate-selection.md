# Editor Substrate Selection

Status: promoted-first-pass
Owner: Tom
Updated: 2026-07-10

## Purpose

Choose the first code-editor substrate without turning Nucleus into a VS Code
workbench clone or letting browser state become file authority.

## Product Fit

The first editor must fit the approved workspace panel set and stay visually
quiet. It needs a real open-edit-save path, syntax presentation, normal editing
commands, search, undo/redo, and a route to later diagnostics and completion.
It does not need a VS Code extension host, permanent file explorer, multi-tab
IDE shell, language-server runtime, or theme marketplace in its first slice.

Nucleus already assigns filesystem, command, language-server, SCM, and durable
state authority to Rust hosts. The editor substrate should render and manage a
responsive client buffer without replacing that split.

## Candidate Comparison

| Candidate | Strength | Cost for Nucleus | Decision |
| --- | --- | --- | --- |
| CodeMirror 6 | Modular ESM packages, immutable editor state, composable extensions, Vite fit, syntax/search/completion/lint/merge primitives | Nucleus must select and compose the desired extensions | Selected |
| Monaco | VS Code-derived editing core, rich standalone editor, URI-backed models, built-in diff and browser language services | Worker setup, broader default surface, no normal VS Code extension compatibility, external TextMate integration | Deferred |
| VS Code workbench / Code OSS embedding | Full workbench and extension-host direction | Replaces rather than fills the Nucleus workspace shell; much larger authority and product commitment | Rejected for first editor |

## Decision

Use CodeMirror 6 through its official packages as the first Nucleus client
editing substrate.

Integration rules:

- create one thin Nucleus-owned Svelte adapter around `EditorView`
- do not adopt a community Svelte wrapper as an authority boundary
- keep CodeMirror state local and disposable
- derive dirty state from the current buffer versus the latest accepted host
  snapshot
- resolve file identity, content, revision, write permission, save conflicts,
  and future language-server processes through Rust host APIs
- style CodeMirror from Nucleus/Poodle tokens rather than importing a VS Code
  visual shell
- treat VS Code-compatible theme import as a later translation feature, not a
  property implied by the substrate

## Initial Extension Set

The first slice may compose official CodeMirror packages for:

- state and view
- commands and history
- line numbers, selection, bracket matching, folding, and indentation
- search and replace
- language-mode selection and syntax highlighting
- later lint, completion, and merge adapters without activating LSP yet

Language packages should be loaded through a Nucleus registry keyed by the
host-provided language hint. The initial registry should cover only repository
file types needed to validate the current workspace.

## Host Boundary Implications

The host returns an editor file snapshot with opaque file identity, safe
project-relative display path, content, language hint, size, write capability,
and an opaque content revision.

Save sends the opaque file identity, expected content revision, and full
replacement content. The host re-resolves the file inside the current project,
rejects stale revisions or policy violations, performs the write, and returns a
new accepted snapshot. The client never treats an absolute path or its cached
buffer as write authority.

File discovery is a separate bounded read query. It respects project scope,
ignore rules, file-size policy, and host authorization. Quick open consumes
that query; it does not crawl the filesystem from Svelte.

## Sources

- CodeMirror system guide: <https://codemirror.net/docs/guide/>
- CodeMirror reference, including merge support:
  <https://codemirror.net/docs/ref/>
- Monaco Editor repository and FAQ:
  <https://github.com/microsoft/monaco-editor>
- VS Code language-server extension architecture:
  <https://code.visualstudio.com/api/language-extensions/language-server-extension-guide>

## Promotion

Promoted into:

- `docs/architecture/system-architecture.md`
- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/006-workspace-layout-contract.md`
- `docs/specs/006-initial-code-editor-vertical-slice.md`
- `docs/roadmaps/g04/028-initial-code-editor-vertical-slice.md`
