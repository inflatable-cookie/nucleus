# 004 Display Window Surface Layout

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Shape how Nucleus should adopt the Loophole display, window, surface, region,
and panel hierarchy before serious workspace UI work resumes.

This is not a UI design spec. It is an authority and layout model spec.

## Source Material

Primary reference:

- `../loophole/echo/crates/echo-windowing/src/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/window_plan/types.rs`
- `../loophole/echo/crates/echo-ipc-codecs/src/machine/types.rs`
- `../loophole/chorus/contracts/ui/display-window-hosting-and-surface-baseline-contract.md`
- `../loophole/chorus/contracts/ui/hosted-surface-lifecycle-baseline-contract.md`
- `../loophole/chorus/roadmaps/g08/plans/spark-workspace-shell-implementation-guide.md`

Useful Loophole concepts:

- machine-local display inventory
- canonical display ids
- window targets and display fallbacks
- stable window ids distinct from native host handles
- hosted surfaces scoped to windows
- active surface per window
- ordered surface inventory per window
- deterministic active-surface fallback
- surface tabs distinct from panel tabs

## Nucleus Direction

Nucleus should use the hierarchy:

```text
display -> window -> surface -> region -> panel
```

Panel layout can be Nucleus-specific:

- left project/activity sidebar
- flexible main stage
- dynamic split views
- drag-and-drop tabs
- optional right sidebar
- optional bottom bar

The transferable Loophole part is not the exact panel arrangement. The
transferable part is the hosting model that lets a dev environment adapt across
multiple displays, multiple windows, and multiple top-level work surfaces.

Key Nucleus difference:

- Loophole is inherently single-project.
- Nucleus is fundamentally multi-project.
- Display, window, and surface configuration should be global user/client
  state.
- Only panel layout rules are per-project in the first model.
- The left project/activity panel owns quick project switching.
- When the active project changes, the project's panels adapt into the global
  window/surface arrangement.
- Per-project surfaces may be explored later, but are out of scope until the
  basic model is running.

## Authority Model

Machine-local authority owns display detection and display labels.

The local client profile owns global display/window/surface configuration,
surface ordering, active-surface fallback, and persisted UI shell state.

The local client profile also owns per-project panel layout rules.

The authoritative engine host owns server-managed resources that surfaces
attach to: agent sessions, terminals, browser resources, editor file authority,
SCM state, runtime receipts, planning/research/memory records, and task state.

Clients render and dispatch intents. The renderer does not become the source
of truth for window targeting, hosted-surface identity, active-surface
fallback, or persisted workspace layout state; the local client profile layer
does.

Workspace layout is not shared project management state. It should not be
committed to the project repository. The first persistence target should be
local client profile storage, likely the client-side SQLite database if the
desktop app already maintains one.

Global shell records should be keyed by client profile. Per-project panel
layout records should be keyed by client profile, project id, and panel layout
id.

## Initial Rust Shape

Likely crates:

- `nucleus-workspaces` owns domain types for display refs, window config,
  hosted surface records, regions, panels, and lifecycle command vocabulary.
- `nucleus-server` exposes server-managed resource refs for surfaces to attach
  to, but should not be required to persist local panel arrangements.
- Tauri desktop adapts host-native display/window APIs into machine-local
  display inventory, host window handles, and client-profile layout database
  records.

Open choice:

- port Loophole `echo-windowing` concepts into Nucleus
- recreate the model with Nucleus names
- extract a shared crate later if both projects need the same implementation

Do not decide this from documentation alone. Inspect the current Loophole
crate before implementation.

## Initial Stop Line

Do not build the real panel shell until these are clear:

- display inventory record shape
- workspace window config shape
- global hosted surface record shape
- per-project panel layout rule shape
- window-scoped lifecycle commands
- local client profile persistence schema, likely SQLite-backed
- separation between local UI layout state and committable project management
  files
- fallback semantics for missing displays and closed active surfaces
- client degradation behavior for web, mobile, and CLI

Do not copy Loophole panel defaults blindly. Nucleus is a development
environment, not a DAW.

## Promotion Targets

Promoted now:

- `docs/contracts/006-workspace-layout-contract.md`

Still to promote before implementation:

- architecture inventory entry for display/window/surface hosting
- roadmap milestone or batch cards for workspace hosting model extraction
- possible control API contract additions for hosted-surface lifecycle commands
- local client layout storage contract or section

## Open Questions

- Should Nucleus port `echo-windowing` directly or implement a local equivalent
  in `nucleus-workspaces`?
- How should display identities survive OS/client differences?
- How should a remote server-authoritative project map windows onto a local
  client machine's displays?
- Which hosted surface kinds should exist in the first Nucleus workspace
  shell?
- How far should the first Tauri app go before the UI is redesigned?
- Should layout preference sync exist later, and if so, should it be opt-in
  per user profile rather than project-committed state?
- What would make per-project surfaces worth the complexity later?
