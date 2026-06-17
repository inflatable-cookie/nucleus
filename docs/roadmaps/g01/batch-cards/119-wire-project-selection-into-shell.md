# 119 Wire Project Selection Into Shell

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Let the desktop shell track the currently selected project as local view state.

## Scope

- Track selected project id in the Svelte shell.
- Highlight the selected project.
- Keep selection local and non-durable.

## Out Of Scope

- Persisted workspace/project focus state.
- Project mutation.
- Task panels.

## Promotion Targets

- `apps/desktop/src`
- `docs/roadmaps/g01/014-read-only-desktop-project-switcher.md`

## Acceptance Criteria

- [x] Selecting a project updates local shell state.
- [x] Selection does not mutate server state.
- [x] Empty project lists remain valid.

## Notes

- `App.svelte` now owns `selectedProjectId` as local view state.
- `ProjectSwitcherPanel` receives a bindable selection prop and only mutates
  local shell state.
- Selection is still not persisted or sent to the server.
