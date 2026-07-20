# 002 Project Layout Desktop Binding

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../001-project-scoped-workspace-layouts.md`
Auto-start next card: yes

## Objective

Reload and persist the workspace layout against the selected project without
cross-project races or stale debounced writes.

## Acceptance

- [x] switching projects reloads panels, tab order, active tabs, and split ratios
- [x] every mutation carries the project id captured when it was made
- [x] late loads and saves cannot replace the newly selected project's view
- [x] the header launcher reflects only the selected project's open panels

## Validation

- desktop type check and focused client tests
- native switching smoke across two projects

## Stop Conditions

- project selection is persisted as layout authority
- panel content state is copied between projects
- the normal shell gains a layout-management toolbar
