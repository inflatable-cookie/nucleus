# 006 Workspace Layout Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the persisted project workspace layout model.

Workspace layout belongs to a project. It is not a desktop-only preference and
must be usable by future desktop, web, mobile, and CLI control planes where the
surface allows it.

## Workspace Identity

Each workspace layout must expose:

- stable workspace layout id
- project id
- display name
- layout status
- panel tree
- focused panel id
- open surfaces
- client scope
- timestamps

## Layout Status

Initial states:

- active
- saved
- archived

Active means the layout is currently being used or restored for a project.
Saved means it is retained as a selectable preset. Archived means retained for
history or recovery but excluded from normal workspace selection.

## Panel Model

Panels are durable layout containers.

Each panel must expose:

- stable panel id
- panel kind
- tab ids
- active tab id
- split direction where relevant
- size hint
- child panel ids where relevant

Panel geometry is advisory until concrete client rendering rules exist.
Clients may adapt geometry to their surface, but the server remains authority
for persisted layout state.

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

## Current Rust Surface

`nucleus-workspaces` now contains the first draft of:

- `WorkspaceLayoutId`
- `PanelId`
- `SurfaceId`
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

These are descriptive domain types only. Rendering, layout migration, terminal
process control, browser control, editor implementation, language-server
integration, plugin execution, SCM mutation, and client synchronization remain
out of scope.

## Research Gaps

- Exact panel tree validation rules.
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
