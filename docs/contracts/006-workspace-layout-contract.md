# 006 Workspace Layout Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-08-01

## Purpose

Define the local workspace layout model.

Display and window configuration is global user/client state because Nucleus
is fundamentally multi-project. Panel arrangement is per project and adapts
into available windows.

Workspace layout state is local client state. It is not committed to the
project repository like tasks, project metadata, planning docs, or other
shared management files.

Desktop persistence is split between `state/window-placement.json` and
the registered `config/project-layouts.json` domain below the selected
Longhorn storage profile. Product presentation metadata and project-local
working focus live separately in `config/project-panel-presentations.json`.
Project layouts are deterministic containers keyed from project id inside one
local layout document.

These JSON files are local client state, not project state. If the client state
store moves to SQLite later, they become import/export or migration sources
rather than competing authority.

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

Longhorn owns structural layout definitions, validation, expected-revision
mutation, normalization, and registered publication. Nucleus supplies the
five-region schema, product panel registry, project-to-container identity,
minimal seed policy, presentation metadata, and runtime cleanup.

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

The local workspace presentation domain may retain references to those durable
records so a project can restore its working focus. Those references are not a
second Goal, Task, conversation, or authority model. The authoritative host
still resolves current records before use.

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

The native desktop persists one primary-window placement record in
`state/window-placement.json`, separate from regions and split ratios. The record
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
coalesces move and resize writes, and flushes current placement on close.
Window placement and project layout publish through separate registered
domains and files. A write to either domain cannot rewrite the other. The
renderer receives host-owned placement for composition, but project-layout
publication never accepts it as layout authority.

Native monitor names are not canonical hardware ids. The first display key is
a recovery hint composed from name, physical origin, and size. Stable hardware
identity remains a later machine-inventory concern; bounded fallback is
mandatory in the meantime.

## Region And Panel Model

Regions and panels are layout structure directly below a window.

Panel layout is the per-project layer. Each project can define how its panels
populate available windows and how they adapt when the user switches projects.

The initial Nucleus dev-environment shell should plan for:

- left workspace sidebar with Projects, Threads, Files, and Forge views
- centerTop primary workspace region
- centerBottom secondary workspace region
- rightTop primary side workspace region
- rightBottom secondary side workspace region

Panel layout may differ from Loophole's DAW-oriented defaults. The reusable
part is display/window placement. Panel tabs are the only workspace tabs.

The main workspace is a fixed semantic two-column by two-row grid. Terminals,
editors, browsers, agent chats, task views, diffs, memory, and other workspace
tabs may move between any of its four regions. The left project/activity region
remains separate and is not a general workspace-tab destination.

The initial region set is:

- `left`: project/activity navigation and active-work awareness
- `center_top`: primary workspace panels and the default task panel dock
- `center_bottom`: secondary workspace panels
- `right_top`: contextual panels by default, or any moved workspace tab
- `right_bottom`: secondary side workspace panels

Arbitrary VS Code-style split trees are not the first default. They may exist
later as a power-user feature, but the first model should be semantic and
workflow-led so users are not forced to manage layout before the product flow is
clear.

Panel layout records are local UI preference/state records scoped by project.
They should not be written into the project repository by default.

The full-height workspace sidebar is global client shell state, not per-project
panel layout. Its selected view and width may be persisted locally by the
client, but they must not be committed into project repositories. Only one
sidebar view is visible at a time. Projects and Forge may span projects;
Files is scoped to the selected project's resources.

Panel definitions must carry placement policy, not just current placement. This
mirrors Loophole's `PanelDefinition.allowedRegions` model:

- each panel has a default region
- each panel has an explicit allowed-region list
- every workspace panel kind allows `center_top`, `center_bottom`, `right_top`,
  and `right_bottom`
- project/activity panel kinds remain restricted to `left`
- same-region tab reorder preserves the panel's region
- cross-region drag is accepted only when the target region is allowed
- cross-region drag should show visible drop targets for every currently
  allowed target region
- empty regions should collapse out of the normal layout and reappear during a
  drag only when they are valid drop targets
- rejected drops must not mutate local layout state
- closeability, movability, and system-panel status are separate flags

The registered panel-definition policy, not each stored panel record, owns
allowed placement, closeability, movability, and instance count. Raw schemas
1 through 10 migrate backup-first into the registered layout domain. A former
single layout becomes a one-time pending candidate claimed by the first
project loaded after upgrade; other unseen projects receive the minimal Agent
Chat-only layout.

Closeable panels must have a recovery path. In the first product shell, the
header `+` menu creates fresh panel instances for known panel kinds such as
agent chat, terminal, browser, editor, diff, and memory. This is not yet a
workspace preset manager; it only prevents closed tool panels from becoming
unreachable during UI bring-up.

Region sizing is local UI state. The first desktop shell stores split ratios on
the window layout record:

- `left_center_ratio`
- `center_right_ratio`
- `center_stack_ratio`
- `right_stack_ratio`

These ratios are client-local preferences in `config/project-layouts.json`.
They are stored per project and must not be committed into project
repositories by default.

The minimal layout for a project without a retained local layout contains one
Agent Chat panel in `center_top`. Tasks, Terminal, Browser, Editor, Diff, and
Memory are added only when requested. The default must not be inferred from
another project's current tabs.

## Project Switch And Recovery Semantics

Changing the selected project creates a hard renderer epoch boundary.

- the previous project's panel tree stops rendering and receiving input before
  the next project layout is presented
- panel-launcher availability and active-command context clear while the next
  project layout loads; they must never describe the previous project
- rapid project changes are latest-selection-wins; a late snapshot or mutation
  result from an older project epoch must not become visible
- the global shell, project rail, and project selection remain usable while a
  project layout loads, reconnects, or fails
- a successful switch restores only the selected project's panels, active tabs,
  region placement, and sizing

An all-panels-closed layout is valid retained state. Loading it must not silently
reseed Agent Chat or copy another project's layout. The empty workspace presents
one direct `Open Agent Chat` recovery action; the header `+` menu remains the
secondary route to all known panel kinds.

A failed layout connection remains a workspace-local failure. Retry reconnects
the selected project's exact registered layout. It must not reset, replace, or
repair persisted layout data without a separate host-owned recovery contract.
Selecting another project remains available during failure.

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

- the task panel is a closeable singleton workspace tab
- the header `+` menu restores it after close and disables its Tasks launcher
  while one Tasks panel is already open
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

## Project Working Context

Each project may retain one local working-context projection alongside panel
presentation metadata:

- optional selected Goal id
- optional selected Task id
- optional active conversation id

Each Agent Chat panel may also retain its own optional conversation attachment.
The project-level conversation id identifies the last selected thread; the
panel attachment identifies which thread that panel presents. Neither creates
a durable conversation-to-Goal or conversation-to-Task binding.

The working-context projection is local client state. It survives panel close,
project switching, and desktop restart, but is not committed into project
management state. Goal and Task records, conversation history, and lifecycle
authority remain server-owned.

Selection rules:

- selecting a Goal clears Task focus unless a contained Task is selected at
  the same time
- selecting a grouped Task records both its Goal and Task ids
- selecting an ungrouped Task clears Goal focus
- clearing a composer chip updates the same project working context used by
  Tasks and Diff
- a missing, deleted, or cross-project record is cleared when the owning panel
  resolves current server state; stale client fields never become turn context
- selecting a thread from Projects or Threads activates an Agent Chat panel,
  updates that panel's conversation attachment, and updates the same active
  conversation highlight in both sidebar views
- activating another attached Agent Chat panel updates the project-level active
  conversation without rewriting either conversation

The workspace stage owns one reactive projection of this state. Individual
panels consume it; they do not keep competing selected Goal, Task, or active
conversation stores.

The first Agent Chat composer is one floating surface centered over the bottom
of its timeline. It keeps the message field primary and places only model,
reasoning, selected-context, and send controls in the normal path. Selected
Goal and Task context appears as compact removable chips. Errors attach to the
composer. Shortcut help, access mode, attachments, build mode, and other
advanced controls do not become a permanent footer.

The timeline must reserve enough bottom space for the floating composer at its
largest normal height. Composer controls must remain usable when the panel is
narrow; secondary controls may wrap without introducing horizontal scrolling.

## Shell Accessibility And Responsive-State Rules

Workspace interaction must remain usable without a pointer and without relying
on the outer window width as a proxy for panel width.

- interactive shell affordances use native controls or Poodle primitives with
  their documented semantics; static elements do not receive click, pointer,
  key, or focus handlers to imitate controls
- every pointer-only convenience, including double-click rename, retains a
  keyboard-reachable route through the same row, menu, or explicit action
- tabs, menus, dialogs, editable labels, and splitters retain their Poodle
  keyboard and focus behavior; Nucleus does not add a competing focus model
- focus remains visible and returns to a stable owning control after a dialog,
  inline edit, or transient menu closes
- selected project, thread, tab, and panel state uses native selected/current
  semantics where the component contract provides them

Panels adapt to their own rendered container. A panel can be narrow inside a
wide native window, so panel and region composition must use container queries
or measured panel state rather than viewport media queries. The outer titlebar
may use a viewport query because it belongs to the native window.

- chrome, forms, and primary actions must not require horizontal scrolling
- content that is intrinsically horizontal, including terminals, unified diffs,
  and editor text, may keep its own bounded scroll surface
- primary actions remain visible at the narrow supported size; secondary copy
  may truncate, wrap, or move behind an existing menu or disclosure
- panel roots and intermediate flex/grid containers keep `min-width: 0` and
  `min-height: 0` where needed to prevent accidental layout expansion
- responsive adaptation is presentation state and is never persisted as a new
  layout authority

Loading, empty, failed, and recovery states stay local to the smallest owning
surface.

- loading and successful background updates use polite status semantics
- a newly actionable failure uses alert semantics once; retained diagnostics do
  not repeatedly announce on every render
- a retry repeats the exact failed read, connection, or panel-local open; it
  does not create another panel, choose another resource, or mutate durable state
- failure copy leads with the operator-relevant outcome. Technical identifiers
  and raw diagnostics stay behind existing details or diagnostic surfaces
- healthy state remains quiet. Global banners and toasts are reserved for
  failures whose ownership or required action is genuinely cross-panel

Closeable and movable workspace tabs include tasks, terminal, browser, editor,
diff, research, logs, and similar resource views. Tasks differs only by being a
singleton with an explicit launcher recovery path.

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

Terminal panels attach to host-managed resources. Browser panels use the local
native child-webview runtime defined by
`028-browser-panel-runtime-contract.md`; their remote content remains outside
the trusted bundled client.

Resource target presentation is conditional panel chrome, not another region
or permanent workspace bar. Agent Chat, Editor, and Terminal may expose the
same compact selector when target choice or repair is material. Browser does
not show that selector: its URL is not a project resource and its first runtime
is explicitly local. A normal healthy local host stays visually quiet. A panel
may show bounded connecting, failed, or non-local host evidence inside its own
chrome, using the host-confirmed runtime identity rather than a client guess.

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

Diff-to-Editor navigation must preserve the source snapshot's project resource
id and safe display path as well as its opaque file ref. A multi-resource
project must not resolve a reviewed file against the default or first resource
merely because the client dropped the evidence resource identity.

After a durable Needs changes decision, Diff may expose one compact
`Address changes` action. The action focuses or creates an Agent Chat panel,
keeps the selected Task in the shared project working context, and prepares a
bounded rework prompt in the composer. It must not submit the prompt, start a
turn, run a task, or treat the review decision as execution authority. Existing
composer text is preserved. The operator sending the prepared message is the
fresh conversation mandate required by the task workflow contract.

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

The desktop host registers the exact Nucleus shape with `longhorn-layout` and
persists it through `longhorn-layout-config`:

- regions: `left`, `center_top`, `center_bottom`, `right_top`, `right_bottom`
- sizing slots: `left-center`, `center-right`, `center-stack`, `right-stack`
- project-keyed deterministic containers
- product panel definitions, including Tasks as `OnePerContainer`
- expected-revision create, close, activate, reorder, move, and resize
- backup-first schemas 1 through 10 import
- one Agent Chat seed for a new project

Titles, external panel ids, resource targets, editor file refs, and forge diff
refs live in the Nucleus-owned panel-presentation domain. Terminal sessions,
browser webviews, panel bodies, and cleanup remain runtime concerns. They do
not enter Longhorn layout documents.

`nucleus-workspaces` now retains only server-facing product planning records.
Its unused local display, window, region, project-panel, planning, and local
persistence modules were removed. It is not desktop layout authority.

## Research Gaps

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
