# 012 Desktop Control Diagnostics And Panel Foundation

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Turn the desktop shell into the first real read-only panel surface without
moving authority into TypeScript.

## Scope

- Add a control diagnostics panel.
- Keep state/query construction thin in TypeScript.
- Route all data access through the Tauri command and Rust server boundary.
- Establish enough local panel structure for later project and task panels.
- Reassess project switcher readiness after diagnostics is working.

## Out Of Scope

- Project creation.
- Task creation or task assignment.
- Terminal, browser, editor, or SCM panels.
- Live subscriptions.
- Remote transport.
- Provider process lifecycle.

## Decisions

- Control diagnostics is the first panel because it can validate the desktop
  command path, protocol version, backend reachability, and error reporting
  without requiring project/task mutation behavior.
- Project switcher and task list panels are deferred until the server has
  mutation paths or fixture/seed flows that make them meaningful.
- The desktop may introduce small Svelte components for panel layout, but Rust
  remains the authority for state, query execution, and command results.
- The first diagnostics panel exists and uses the existing runtime metadata
  probe. Additional query helpers come next.
- Project switcher is not ready after diagnostics because project records are
  still opaque storage envelopes and project mutation/seed flows do not exist.

## Execution Plan

- [x] Add desktop control diagnostics panel.
- [x] Add a small desktop control-query helper set.
- [x] Reassess project switcher readiness after diagnostics.

## Acceptance Criteria

- [x] Diagnostics panel can issue at least one runtime metadata query.
- [x] Diagnostics panel can issue at least one state list query.
- [x] The UI renders protocol family/version, response status, and errors.
- [x] TypeScript remains DTO/view glue only.
- [x] No project/task mutation behavior is introduced.

## Closeout

Diagnostics and query helper work is complete. Project switcher work is routed
to `013-project-state-records-and-switcher-readiness.md`.

## Cards

- `docs/roadmaps/g01/batch-cards/111-add-desktop-control-diagnostics-panel.md`
- `docs/roadmaps/g01/batch-cards/112-add-desktop-control-query-helpers.md`
- `docs/roadmaps/g01/batch-cards/113-reassess-project-switcher-readiness.md`
