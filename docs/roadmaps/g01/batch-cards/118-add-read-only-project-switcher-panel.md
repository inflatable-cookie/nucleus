# 118 Add Read-Only Project Switcher Panel

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Add a desktop panel that lists server-owned project records.

## Scope

- Add a Svelte project switcher component.
- Query project list through existing control helpers.
- Render `project_records` display DTOs.
- Include loading, empty, and error states.
- Keep selection local and view-only for this card.

## Out Of Scope

- Project creation.
- Project editing.
- Repo membership views.
- Task list.
- Workspace persistence.

## Promotion Targets

- `apps/desktop/src`
- `apps/desktop/README.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/014-read-only-desktop-project-switcher.md`

## Acceptance Criteria

- [x] Project switcher renders the seeded `Nucleus Local` project.
- [x] It handles empty/error/loading states.
- [x] It does not parse raw storage payload bytes.
- [x] It does not add mutation commands.

## Notes

- Added `ProjectSwitcherPanel.svelte`.
- Project data comes from `project_records` control response DTOs.
- Selection is local to the component in this card.

## Validation

```sh
bun run check
bun run build
cargo test -p nucleus-desktop
```
