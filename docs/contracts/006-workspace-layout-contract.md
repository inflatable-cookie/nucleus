# 006 Workspace Layout Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-07-14

## Purpose

Define the local workspace layout model.

Display and window configuration is global user/client state because Nucleus
is fundamentally multi-project. Panel arrangement is per project and adapts
into available windows.

Workspace layout state is local client state. It is not committed to the
project repository like tasks, project metadata, planning docs, or other
shared management files.

The first desktop bring-up persistence target is
`~/.nucleus/config/ui.json`. Global display/window records should be keyed by
client profile. Per-project panel layout records should be keyed by client
profile, project id, and panel layout id.

This JSON file is local client state, not project state. It is acceptable as
the first authority while the desktop shell is still proving the layout model.
If the client state store moves to SQLite later, this file should become an
import/export or migration source rather than competing authority.

Future sync of layout preferences may exist, but it must be explicit user
preference sync. It must not become part of the default project-management
projection.

Nucleus reuses the Loophole display identity, window placement, and display
fallback concepts. It does not reuse hosted Surfaces.

Reference sources:

- `../loophole/echo/crates/echo-windowing/src/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/window_plan/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/machine/types.rs`
- `../loophole/chorus/contracts/ui/display-window-hosting-and-surface-baseline-contract.md`

## Hosting Hierarchy

The workspace hosting tree is:

- display
- window
- region
- panel

Rules:

- displays are machine-local inventory records
- windows target canonical display ids
- windows may define fallback display ids
- regions live directly inside windows
- panels live in regions and provide the only workspace tab hierarchy
- panel resource attachments do not create another layout identity layer

The first Nucleus panel system keeps semantic regions. It does not add a
generic split tree or a second top-level workspace tab strip.

## Authority Split

The local machine authority owns:

- display inventory
- display labels and label overrides
- display availability
- display bounds and scale metadata where known
- arrangement signatures or equivalent recovery hints

The local client profile owns:

- global window configuration against canonical display ids
- global window fallback display order
- per-project panel layout rules
- local layout persistence and recovery state

The authoritative engine host owns:

- project, task, agent, runtime, SCM, memory, planning, and research state
- server-managed resources that panels attach to
- authorization for filesystem, SCM, command, browser, terminal, and provider
  actions
- durable refs that a local panel can point at

The client renderer owns:

- presentation
- drag affordances
- hover and transient focus state
- local measurement needed to render smoothly

The renderer does not own display targeting or window fallback semantics.
Those are local client profile state, not transient renderer state.

The renderer also does not own server-managed resources or project
management state.

## Display Model

Displays are machine-local capabilities. They should expose:

- stable canonical display id where possible
- optional host/internal display id
- availability
- main/built-in flags where known
- physical bounds
- usable bounds
- scale factor
- machine label
- optional user label override

Display ids are not project ids. Display placement is global user/client
state, not per-project state. Display availability is resolved per client
machine.

When a display disappears, windows must resolve through configured fallback
ids or a deterministic bounded fallback. Renderer code must not invent its own
display fallback.

## Window Model

Workspace windows are durable local global layout targets.

Each window should expose:

- stable window id
- host role, such as primary or secondary
- target display id where configured
- fallback display ids
- per-display geometry where available
- window region sizing
- project panel placement against the window regions

Concrete native window handles are runtime-local and must not become persisted
workspace identity.

The first native desktop persists one primary-window placement record in
`~/.nucleus/config/ui.json` beside its regions and split ratios. The record
contains a best-effort display identity, normal unmaximized outer bounds in
physical pixels, and maximized state.

Native placement restore follows one deterministic order: saved display,
available display with the largest intersection with saved bounds, primary
display, first available display, then the Tauri default when no display can be
read. Restored bounds are clamped inside the selected display work area. Stored
size is normalized to the desktop minimum and a generous corruption ceiling.
A maximized window retains its last normal bounds rather than replacing them
with maximized bounds.

The native host owns restore and capture. It restores before first show,
coalesces move and resize writes, and flushes current placement on close. Each
geometry write merges into the latest config under the same local file lock as
panel-layout writes. Geometry persistence must not overwrite concurrent region
or panel changes. Renderer-originated workspace saves preserve the current
host-owned placement rather than accepting placement fields from the client.

Native monitor names are not canonical hardware ids. The first display key is
a recovery hint composed from name, physical origin, and size. Stable hardware
identity remains a later machine-inventory concern; bounded fallback is
mandatory in the meantime.

## Region And Panel Model

Regions and panels are layout structure directly below a window.

Panel layout is the per-project layer. Each project can define how its panels
populate available windows and how they adapt when the user switches projects.

The initial Nucleus dev-environment shell should plan for:

- left project/activity sidebar
- centerTop primary workspace region
- centerBottom secondary workspace region
- rightTop primary side workspace region
- rightBottom secondary side workspace region

Panel layout may differ from Loophole's DAW-oriented defaults. The reusable
part is display/window placement. Panel tabs are the only workspace tabs.

The main workspace is a fixed semantic two-column by two-row grid. Terminals,
editors, browsers, agent chats, task views, diffs, context, and other workspace
tabs may move between any of its four regions. The left project/activity region
remains separate and is not a general workspace-tab destination.

The initial region set is:

- `left`: project/activity navigation and active-work awareness
- `centerTop`: primary workspace panels and the default task panel dock
- `centerBottom`: secondary workspace panels
- `rightTop`: contextual panels by default, or any moved workspace tab
- `rightBottom`: secondary side workspace panels

Arbitrary VS Code-style split trees are not the first default. They may exist
later as a power-user feature, but the first model should be semantic and
workflow-led so users are not forced to manage layout before the product flow is
clear.

Panel layout records are local UI preference/state records scoped by project.
They should not be written into the project repository by default.

The full-height project rail is global client shell state, not per-project
panel layout. Its width may be user-resizable and persisted locally by the
client, but it must not be committed into project repositories.

Panel definitions must carry placement policy, not just current placement. This
mirrors Loophole's `PanelDefinition.allowedRegions` model:

- each panel has a default region
- each panel has an explicit allowed-region list
- every workspace panel kind allows `centerTop`, `centerBottom`, `rightTop`, and
  `rightBottom`
- project/activity panel kinds remain restricted to `left`
- same-region tab reorder preserves the panel's region
- cross-region drag is accepted only when the target region is allowed
- cross-region drag should show visible drop targets for every currently
  allowed target region
- empty regions should collapse out of the normal layout and reappear during a
  drag only when they are valid drop targets
- rejected drops must not mutate local layout state
- closeability, movability, and system-panel status are separate flags

The first desktop shell persists this as `allowed_regions` on local panel
records in `~/.nucleus/config/ui.json`. This is a bring-up representation of
the same policy shape, not the final server API.

Closeable panels must have a recovery path. In the first product shell, the
header `+` menu creates fresh panel instances for known panel kinds such as
agent chat, terminal, browser, editor, diff, and context. This is not yet a
workspace preset manager; it only prevents closed tool panels from becoming
unreachable during UI bring-up.

Region sizing is local UI state. The first desktop shell stores split ratios on
the window layout record:

- `left_center_ratio`
- `center_right_ratio`
- `center_stack_ratio`
- `right_stack_ratio`

These ratios are client-local preferences below `~/.nucleus/config/ui.json`.
They must not be committed into project repositories by default.

## Chat-Led Task Model

Nucleus is chat-led and task-backed, not task-screen-led.

The primary interaction path is an AI agent conversation. A user can talk
through a problem with an agent, and the agent can create, refine, update, and
dispatch tasks through server-authorized tools or skills. The task list is the
structured work ledger behind that conversation, not necessarily the screen
where work starts.

It must be valid for a user to complete a planning-to-dispatch flow without
opening the task panel. The task panel exists for explicit inspection and
manual control when wanted.

Task panel rules:

- the task panel is a system panel, not an ordinary closeable tab
- it is uncloseable in normal operation
- it may be collapsed or hidden by the current window layout, but it is not
  destroyed
- its default dock is `centerTop`
- it may move to any of the four main workspace regions
- it is project-scoped
- it must not become the primary interaction model by default

Agent chat rules:

- agent chat is a primary workspace panel
- agent chat may create, update, attach to, or dispatch tasks
- agent chat should keep task context visible enough to make task-backed work
  understandable without forcing the task panel open
- active task/thread state should be visible through project/activity panels
  even when the task panel is not open

The first Agent Chat composer is one floating surface centered over the bottom
of its timeline. It keeps the message field primary and places only model,
reasoning, selected-context, and send controls in the normal path. Selected
Goal and Task context appears as compact removable chips. Errors attach to the
composer. Shortcut help, access mode, attachments, build mode, and other
advanced controls do not become a permanent footer.

The timeline must reserve enough bottom space for the floating composer at its
largest normal height. Composer controls must remain usable when the panel is
narrow; secondary controls may wrap without introducing horizontal scrolling.

Closeable and movable workspace tabs include terminal, browser, editor, diff,
research, logs, and similar resource views. These are ordinary workspace
resources. The task panel is not.

## Workspace Identity

Each global workspace shell layout must expose:

- stable workspace layout id
- display name
- layout status
- window configuration
- client scope
- timestamps

Each per-project panel layout must expose:

- stable panel layout id
- project id
- display name
- layout status
- panel placements
- focused panel id
- panel-to-window and panel-to-region rules
- timestamps

Both record families are scoped to a local client profile. Project ids on panel
layout records link the layout to a project, but do not make the layout shared
project state.

## Layout Status

Initial states:

- active
- saved
- archived

Active means the layout is currently being used or restored for a project.
Saved means it is retained as a selectable preset. Archived means retained for
history or recovery but excluded from normal workspace selection.

## Panel Model

Panels are the durable user-facing tools inside window regions.

Each panel must expose:

- stable panel id
- panel kind/key
- title
- current window and region placement
- allowed regions
- closeable, movable, and system-panel policy
- optional attachment refs to server-managed resources

Panel geometry is advisory until concrete client rendering rules exist. Clients
may adapt geometry to their form factor. Persisted geometry belongs in local
client layout state, not in committed project-management files.

Panel kinds include:

- agent chat
- tasks
- terminal
- browser
- editor
- SCM changes and diff review
- notes and context

Terminal and browser panels attach to server-managed resources. Their presence
does not prove that the desktop client owns the underlying process or browser
state.

Text editor and code editor panels are project workspace tools, not a
replacement for durable project state. The server owns file identity,
authorization, save/apply command authority, and workspace attachment state.
The client may render editor buffers and local interaction state for
responsiveness.

## Initial Editor Buffer And Save Boundary

CodeMirror 6 is the first client code-editor substrate. Nucleus integrates the
official packages through a thin Nucleus-owned Svelte adapter. A community
framework wrapper, CodeMirror document state, or a browser path string must not
become file or save authority.

The first host-authorized file snapshot exposes:

- project id
- opaque file ref
- safe project-relative display path
- full text content
- language hint
- byte size
- writable flag
- opaque content revision

The client may keep the active CodeMirror buffer, selection, undo history,
scroll position, and dirty state locally. Dirty state is derived from the
buffer versus the most recent accepted host snapshot. It is not durable project
state in the first slice.

File discovery is a separate project-scoped host query. It must respect ignore
rules, hard exclusions, file-size limits, text/binary classification, and host
authorization. Results expose safe relative paths and opaque file refs only.
The first UI consumes this query through quick open rather than adding a
permanent file explorer.

Save is a host command containing:

- project id
- opaque file ref
- expected content revision
- replacement text content

The host must re-resolve the file inside the authoritative project root,
confirm write policy, compare the current content revision, reject stale or
out-of-scope writes, perform a safe replacement, and return the new accepted
snapshot. A stale save is an explicit conflict. The client must preserve the
dirty buffer and offer reload or keep-editing choices; it must not silently
overwrite or silently reload.

The first slice supports one active buffer per Editor panel. Editor-internal
buffer tabs, autosave, hot-exit recovery, durable cursor state, and file
watchers remain later work. Opening another file while dirty requires an
explicit discard or cancel choice unless the current buffer is saved first.

CodeMirror themes derive from Nucleus/Poodle tokens. VS Code theme import is a
later translation boundary and is not implied by choosing CodeMirror.

Code editor surfaces should plan for:

- syntax colorization
- language server attachment
- diagnostics
- formatting requests
- rename and code action requests
- theme selection, including VS Code-compatible themes where feasible
- extension or plugin-host integration

Nucleus does not need to become a full IDE before the first editor surface
ships. It does need a clean boundary so early editor implementation does not
block later language-server, theme, extension, and richer editor features.

## Initial Task Diff Review Surface

The existing Diff panel is the first task-attributed source review surface. It
consumes server-owned checkpoint, diff-summary, changed-file, and transient
patch read models. It does not inspect the filesystem, snapshot store, Git
repository, or provider state directly.

Normal presentation stays compact:

- one task/work-item review summary
- one changed-file trigger with filtering in a popover
- one read-only unified file diff
- one small review menu

Binary, oversized, truncated, unavailable, expired, and partial evidence must
remain explicit without adding permanent diagnostic chrome. Advanced metadata,
coverage notices, and recovery detail belong in the changed-file popover or
review menu.

Accept and Needs changes reuse server-owned task review admission and cite the
exact work-item revision plus checkpoint/diff evidence refs. These actions do
not edit source, complete the task, publish SCM state, or imply merge. Open in
Editor may focus or create the existing Editor panel for the selected safe file
ref; it must not introduce editor-internal tabs or a permanent file explorer.

The first Diff panel does not stage, revert, apply hunks, resolve merge
conflicts, commit, push, publish, or send patch content to an agent/model.

Plugin execution may need both TypeScript and Rust host surfaces. TypeScript is
the natural fit for client-side editor extensions and theme parsing. Rust is
the authority boundary for server
state, filesystem access, command authority, language-server process
lifecycle, secret access, SCM actions, and durable audit. Plugin APIs must not
let client-side code bypass server command, file, SCM, or credential policy.

SCM changes, diff, and commit control surfaces are workspace views over
server-owned SCM state and command authority. They may render file status,
diff hunks, staged or selected changes, generated commit messages, conflict
repair proposals, and review workflow actions. They must not mutate SCM state
directly from client state.

SCM UI surfaces should support Git-like workflows first while preserving the
provider-neutral SCM model. A commit control may map to a Git commit, a
Convergence snap or publication preparation, or another provider-equivalent
local capture / shared authority action according to the selected SCM adapter.

AI commit-message generation and conflict-resolution proposals are suggestion
surfaces. Applying them requires server-owned command authority and, where
policy requires it, human approval.

## Client Scope

A layout may be:

- universal
- desktop-only
- web-only
- mobile-only
- CLI-only

Universal is the preferred default. Client-specific layouts are allowed when a
surface cannot sensibly render the same panel structure.

Multi-display desktop layouts are global client-profile state. Per-project
panel rules may adapt to the current global window arrangement, but they do not
own display placement.

## Current Rust Surface

`nucleus-workspaces` now contains the first draft of:

- `WorkspaceLayoutId`
- `ProjectPanelLayoutId`
- `ClientProfileId`
- `DisplayId`
- `WindowId`
- `WindowInstanceId`
- `HostWindowId`
- `DisplayArrangementSignature`
- `PanelId`
- `PanelKey`
- display inventory, availability, bounds, arrangement, and scale hints
- workspace window placement records
- runtime host window instance records
- pure window planning and display fallback helpers
- Nucleus region ids
- per-project window/region panel placement rules
- selected-task shell seed rules
- local-only global shell layout and per-project panel layout record families
- `WorkspaceLayout`
- `WorkspaceLayoutStatus`
- `ClientScope`
- `WorkspaceTimestamps`
- `Panel`
- `PanelKind`
- `SplitDirection`
- `PanelSizeHint`

The workspace-model types above are domain types and pure planning helpers;
they do not themselves implement rendering, layout migration, local SQLite
codecs, resource control, or client synchronization. The first editor is now
realized separately through a Rust host file boundary and a client CodeMirror
adapter. Terminal process control, browser control, language-server
integration, plugin execution, and SCM mutation remain outside this contract's
realized workspace-model surface.

The current Rust surface now distinguishes shared project management
projection files from local client layout records, and separates global shell
layout records from per-project panel layout records at the type boundary.
Actual local storage backend integration, schema migration, conflict handling,
and UI configuration remain future work.

## Research Gaps

- Exact panel tree validation rules beyond selected-task shell seed rules.
- Whether to extract a shared windowing dependency later if Loophole and
  Nucleus both need one maintained implementation.
- How canonical display ids are minted and repaired across Tauri, web, and
  remote clients.
- How window records degrade on web and mobile control planes.
- How terminal and browser resources are bound to server-managed runtime ids.
- Exact file-watcher and hot-exit recovery behavior after the first explicit
  revision-conflict flow.
- How VS Code-compatible themes translate into Nucleus/Poodle and CodeMirror
  theme tokens.
- Exact language-server transport and capability mapping between server-owned
  processes and CodeMirror diagnostics, completion, hover, formatting, rename,
  and code-action extensions.
- Plugin host split between TypeScript client plugins, Rust server plugins, and
  policy-gated cross-boundary APIs.
- How SCM diff and commit controls degrade on web, mobile, and CLI clients.
- How layouts degrade on mobile or CLI control planes.
- How workspace state interacts with live agent sessions.
- Whether layout changes need revision ids or conflict handling.
- Exact local client profile storage backend schema, codecs, migration rules,
  and conflict behavior for global shell layout and per-project panel layout
  state, likely SQLite-backed.
- Whether optional cross-device layout preference sync is needed later.
