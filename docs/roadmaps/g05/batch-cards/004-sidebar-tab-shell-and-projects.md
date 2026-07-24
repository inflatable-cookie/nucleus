# 004 Sidebar Tab Shell And Projects

Status: completed
Owner: Tom
Updated: 2026-07-24
Milestone: `../002-workspace-sidebar-modes.md`
Auto-start next card: yes

## Objective

Add one global sidebar tab shell and leave the Projects view responsible only
for project navigation and management.

## Acceptance

- [x] four compact, accessible sidebar tabs select one view at a time
- [x] sidebar selection persists as local client state
- [x] project selection survives sidebar changes
- [x] active thread rows and transient chat controls leave Projects

## Validation

- desktop type check and build
- native tab switching and project-management smoke

## Stop Conditions

- sidebar tabs become project workspace panels
- changing views changes the selected project
- all four views render concurrently
