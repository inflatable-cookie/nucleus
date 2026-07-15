# 197 Management Projection Resource Binding

Status: planned
Owner: Codex
Updated: 2026-07-15
Milestone: `../041-shared-project-files-control.md`
Auto-start next card: yes

## Objective

Bind the existing management projection and sync machinery to one explicit Git
resource under the generalized project model.

## Acceptance

- target resource and sync policy are durable server-owned state
- existing or dedicated Git resources are supported
- missing and moved projection targets enter repair state
- projects without a projection retain full core functionality

## Stop Conditions

- projection files become the active runtime database
- a management target is inferred from the first attached repository
