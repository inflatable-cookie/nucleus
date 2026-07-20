# 197 Management Projection Resource Binding

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../041-shared-project-files-control.md`
Auto-start next card: yes

## Objective

Bind the existing management projection and sync machinery to one explicit Git
resource under the generalized project model.

## Acceptance

- [x] target resource and sync policy are durable server-owned state
- [x] existing or dedicated Git resources are supported
- [x] missing and moved projection targets enter repair state
- [x] projects without a projection retain full core functionality

## Validation

- focused management projection and project persistence tests
- round-trip target identity and sync policy through server restart
- missing, moved, disabled, and no-projection cases

## Evidence

- durable records identify the selected project resource explicitly
- diagnostics report target health without making projected files authoritative
- project-scoped export and import staging resolve the configured repository on
  the authority host; callers do not supply a repository path
- the projection plan contains only the selected project and its tasks

## Stop Conditions

- projection files become the active runtime database
- a management target is inferred from the first attached repository
- implementation requires a new unresolved authority or identity decision
