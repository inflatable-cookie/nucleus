# 060 Goal Task Cross-Panel Focus

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../020-shared-work-context.md`
Depends on: card 059
Auto-start next card: yes

## Objective

Make Tasks, Agent Chat, and Diff consume one project-local Goal and Task focus.

## Acceptance

- [x] Tasks selection updates the shared project context
- [x] composer chips and Diff follow the same current records
- [x] chip clearing and stale-record cleanup publish the same context
- [x] Tasks may close without erasing Goal or Task focus

## Validation

- [x] focused Svelte and workspace-session fixtures cover grouped, ungrouped,
  cleared, stale, and remounted selection

## Stop Conditions

- do not turn selection into task mutation, assignment, or execution authority

## Evidence

The workspace stage loads one project-scoped Goal and Task projection. Tasks,
Agent Chat, and Diff consume it. Native fixture acceptance confirmed immediate
composer attachment, project switching, Tasks closure, and restart restoration.
