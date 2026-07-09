# 006 Workspace Layout Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-17

## Purpose

Define the local workspace layout model.

Only panel arrangement is per project. Display, window, and surface
configuration is global user/client state because Nucleus is fundamentally
multi-project.

Workspace layout state is local client state. It is not committed to the
project repository like tasks, project metadata, planning docs, or other
shared management files.

The first desktop bring-up persistence target is
`~/.nucleus/config/ui.json`. Global display/window/surface records should be
keyed by client profile. Per-project panel layout records should be keyed by
client profile, project id, and panel layout id.

This JSON file is local client state, not project state. It is acceptable as
the first authority while the desktop shell is still proving the surface model.
If the client state store moves to SQLite later, this file should become an
import/export or migration source rather than competing authority.

Future sync of layout preferences may exist, but it must be explicit user
preference sync. It must not become part of the default project-management
projection.

Nucleus should reuse or recreate the Loophole Echo/Aura display, window, and
surface hosting model before deep panel work begins.

Reference sources:

- `../loophole/echo/crates/echo-windowing/src/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/window_plan/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/machine/types.rs`
- `../loophole/chorus/contracts/ui/display-window-hosting-and-surface-baseline-contract.md`
- `../loophole/chorus/contracts/ui/hosted-surface-lifecycle-baseline-contract.md`

## Hosting Hierarchy

The workspace hosting tree is:

- display
- window
- surface
- region
- panel

Rules:

- displays are machine-local inventory records
- windows target canonical display ids
- windows may define fallback display ids
- surfaces are hosted by windows, not directly by displays
- regions and panels live inside surfaces
- active surface selection is window-scoped
- panel tabs and surface tabs are distinct concepts

The first Nucleus panel system should not flatten this into one generic panel
tree.

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
- global hosted surface inventory
- global active surface per window
- global surface ordering per window
- per-project panel layout rules
- local layout persistence and recovery state

The authoritative engine host owns:

- project, task, agent, runtime, SCM, memory, planning, and research state
- server-managed resources that surfaces attach to
- authorization for filesystem, SCM, command, browser, terminal, and provider
  actions
- durable refs that a local surface can point at

The client renderer owns:

- presentation
- drag affordances
- hover and transient focus state
- local measurement needed to render smoothly

The renderer does not own display targeting, window fallback semantics,
surface ordering truth, or active-surface fallback. Those are local client
profile state, not transient renderer state.

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
- hosted surface ids in order
- active surface id

Concrete native window handles are runtime-local and must not become persisted
workspace identity.

## Hosted Surface Model

Hosted surfaces are the top-level user work surfaces inside windows.

In Nucleus, hosted surfaces are global user/client UI containers by default,
not project-owned objects. The left project/activity panel is responsible for
quick project switching, and the active project adapts its panels into the
current surface/window arrangement according to that project's panel rules.

Per-project surfaces are possible later, but they are deliberately out of the
first model because they create complex configuration and recovery rules.

Examples:

- project overview
- agent session surface
- terminal surface
- browser/preview surface
- editor surface
- SCM changes surface
- review surface
- research/planning surface
- diagnostics surface

Each hosted surface should expose:

- stable surface id
- surface kind
- label/title
- host window id
- lifecycle state
- attachment refs to server-managed resources where applicable

Surface lifecycle commands are window-scoped:

- create surface in window
- duplicate surface in window
- close surface in window
- set active surface for window
- reorder surfaces within window

Active-surface fallback after close or recovery must be deterministic and
owned by the local client profile layout model. It is global client state by
default, not per-project state.

## Region And Panel Model

Regions and panels are layout structure below a hosted surface.

Panel layout is the per-project layer. Each project can define how its panels
populate the global surfaces/windows and how they adapt when the user switches
projects.

The initial Nucleus dev-environment shell should plan for:

- left project/activity sidebar
- right context/actions/review region
- centerTop primary workspace region
- centerBottom secondary workspace region

Panel layout may differ from Loophole's DAW-oriented defaults. The reusable
part is the display/window/surface hosting layer and the distinction between
surface tabs, regions, and panel tabs.

The first panel model must not add a generic bottom region. Terminals, editors,
browsers, agent chats, task views, and other primary workspace furniture belong
in `centerTop` or `centerBottom`. Logs, output, evidence summaries, and
contextual details should appear inside the owning workspace panel or in the
`right` region when they are contextual rather than primary work.

SCM diff panels are allowed in `centerTop`, `centerBottom`, or `right`.
They often behave like primary review furniture, but the right region is also a
natural place for focused diff/review context beside an active chat, editor, or
terminal.

The initial region set is:

- `left`: project/activity navigation and active-work awareness
- `right`: contextual inspector, actions, review, logs, and output when tied
  to the selected work
- `centerTop`: primary workspace panels and the default task panel dock
- `centerBottom`: secondary workspace panels and the only alternate task panel
  dock

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
each surface record:

- `left_center_ratio`
- `center_right_ratio`
- `center_stack_ratio`

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
- it may be collapsed or hidden by the current surface mode, but it is not
  destroyed
- its default dock is `centerTop`
- its only alternate dock in the initial model is `centerBottom`
- it is project-scoped
- it must not become the primary interaction model by default

Agent chat rules:

- agent chat is a primary workspace panel
- agent chat may create, update, attach to, or dispatch tasks
- agent chat should keep task context visible enough to make task-backed work
  understandable without forcing the task panel open
- active task/thread state should be visible through project/activity surfaces
  even when the task panel is not open

Closeable and movable workspace tabs include terminal, browser, editor, diff,
research, logs, and similar resource views. These are ordinary workspace
resources. The task panel is not.

## Workspace Identity

Each global workspace shell layout must expose:

- stable workspace layout id
- display name
- layout status
- window configuration
- hosted surface inventory
- active surface per window
- open surfaces
- client scope
- timestamps

Each per-project panel layout must expose:

- stable panel layout id
- project id
- display name
- layout status
- panel tree
- focused panel id
- panel-to-surface or panel-to-region rules where needed
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

Panels are durable layout containers below a hosted surface.

Each panel must expose:

- stable panel id
- panel kind
- tab ids
- active tab id
- split direction where relevant
- size hint
- child panel ids where relevant

Panel geometry is advisory until concrete client rendering rules exist. Clients
may adapt geometry to their form factor. Persisted geometry belongs in local
client layout state, not in committed project-management files.

## Surface Model

Open workspace surfaces include:

- agent panes
- terminal views
- browser views
- text editor views
- code editor views
- SCM changes views
- SCM diff views
- SCM commit controls
- file views
- notes
- task views

Each surface must expose a stable surface id, surface kind, title, attachment
state, and optional provider-specific metadata.

Surfaces should also be hosted by a window and have window-scoped order and
active-state semantics. Do not model a surface as merely a tab inside one
client-local panel.

Terminal and browser surfaces are attachments to server-managed resources, not
proof that the desktop client owns the underlying process or browser state.

Text editor and code editor surfaces are project workspace surfaces, not a
replacement for durable project state. The server owns file identity,
authorization, save/apply command authority, and workspace attachment state.
The client may render editor buffers and local interaction state for
responsiveness.

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

Plugin execution may need both TypeScript and Rust host surfaces. TypeScript is
the natural fit for client-side editor extensions, theme parsing, and
Monaco/CodeMirror-like integration. Rust is the authority boundary for server
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
panel rules may adapt to the current global window/surface arrangement, but
they do not own display placement.

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
- `SurfaceId`
- display inventory, availability, bounds, arrangement, and scale hints
- workspace window placement records
- runtime host window instance records
- pure window planning and display fallback helpers
- hosted surface records
- window-scoped hosted surface order and active-surface state
- hosted-surface close/reorder/active fallback helpers
- Nucleus region ids
- per-project panel placement rules
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
- `Surface`
- `SurfaceKind`
- `SurfaceAttachmentState`

These are domain types and pure planning helpers only. Rendering, layout
migration, local SQLite codecs, terminal process control, browser control,
editor implementation, language-server integration, plugin execution, SCM
mutation, and client synchronization remain out of scope.

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
- How hosted-surface lifecycle commands are represented in engine commands and
  control API DTOs.
- How terminal and browser resources are bound to server-managed runtime ids.
- How editor buffers, file identity, dirty state, save authority, and file
  watchers are represented.
- Which editor substrate should be used first and how VS Code-compatible themes
  are imported.
- How language-server lifecycle is split between client rendering and
  server-owned process authority.
- Plugin host split between TypeScript client plugins, Rust server plugins, and
  policy-gated cross-boundary APIs.
- How SCM diff and commit controls degrade on web, mobile, and CLI clients.
- How layouts degrade on mobile or CLI control planes.
- How workspace state interacts with live agent sessions.
- Whether layout changes need revision ids or conflict handling.
- Exact local client profile storage backend schema, codecs, migration rules,
  and conflict behavior for global shell layout and per-project panel layout
  state, likely SQLite-backed.
- Whether per-project hosted surfaces are ever worth supporting, and which
  configuration rules would prevent that from becoming confusing.
- Whether optional cross-device layout preference sync is needed later.
