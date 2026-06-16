# 117 Reassess Read-Only Project Switcher Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether the desktop can build a read-only project switcher.

## Scope

- Check display-ready project data.
- Check local project record write/seed path.
- Check desktop control query coverage.
- Decide the next UI card.

## Out Of Scope

- Implementing the switcher.
- Project creation UI.
- Task panels.

## Promotion Targets

- `docs/roadmaps/g01/013-project-state-records-and-switcher-readiness.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- [x] Read-only switcher readiness is explicit.
- [x] If ready, next card is scoped to display/list/select only.
- [x] If not ready, the blocker is routed to the missing server boundary.

## Decision

Read-only project switcher is ready.

Reasons:

- project list queries can return display-ready `project_records`
- local desktop startup seeds one valid `Nucleus Local` project through the
  server state path
- diagnostics already proves the Tauri command path for project list queries
- the first switcher can be display/list/select only, with creation and repo
  management deferred

## Next UI Card

Add a read-only desktop project switcher panel.

Keep it scoped to:

- project list query
- empty/loading/error states
- selecting the visible project in local UI state
- no project creation, project editing, task panels, repo repair, or command
  mutation
