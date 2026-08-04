# 077 Semantic Shell Interaction

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 076
Auto-start next card: yes

## Objective

Remove the remaining shell interaction warning and retain explicit keyboard
routes for project selection and inline rename.

## Acceptance

- [x] project rows use native controls for selection and rename entry
- [x] double-click rename remains a convenience, not the only keyboard route
- [x] project menus still open the same inline rename field
- [x] focus enters the rename field and commit/cancel behavior remains stable
- [x] no event-bearing static wrapper remains in the project row

## Validation

- [x] mounted project-row interaction and Svelte accessibility checks pass

## Stop Conditions

- do not change project selection, lifecycle, or persistence authority
- do not edit Poodle to hide a consumer composition defect

## Evidence

- Project selection is a native button. Double-click and the keyboard-accessible
  project menu enter the same inline rename field.
- Mounted fixtures cover selection, both rename entry routes, Escape, focus,
  local read failure, and exact retry.
- `svelte-check` reports zero errors and zero warnings.
