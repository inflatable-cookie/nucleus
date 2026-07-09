# 103 Product Shell Project Rail List

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../021-product-shell-project-rail.md`

## Purpose

Render the first product project list in the left shell rail.

## Work

- [x] Load project records from the existing read-only project query.
- [x] Render each project with an icon, name, and dropdown chevron.
- [x] Clicking the row/name/chevron makes the project active and toggles the
  dropdown.
- [x] Show project-linked active work under expanded projects.
- [x] Keep the proof harness separate.

## Acceptance Criteria

- [x] The normal shell left rail is no longer empty.
- [x] Project expansion and active selection are distinct but coordinated.
- [x] Active work rows come from existing read-only work-progress records.

## Result

Added `ProjectRail.svelte` and wired it into `App.svelte`.

The rail uses Poodle/Lucide icons, reads projects through the existing control
query, reads project-linked work progress, and keeps the proof harness isolated
behind the existing modal launcher.

## Validation

- `effigy desktop:check`
