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
- file views
- notes
- task views

Each surface must expose a stable surface id, surface kind, title, attachment
state, and optional provider-specific metadata.

Terminal and browser surfaces are attachments to server-managed resources, not
proof that the desktop client owns the underlying process or browser state.

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
process control, browser control, and client synchronization remain out of
scope.

## Research Gaps

- Exact panel tree validation rules.
- How terminal and browser resources are bound to server-managed runtime ids.
- How layouts degrade on mobile or CLI control planes.
- How workspace state interacts with live agent sessions.
- Whether layout changes need revision ids or conflict handling.

## Next Task

Draft adapter registry selection and persistence semantics.
