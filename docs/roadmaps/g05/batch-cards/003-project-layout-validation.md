# 003 Project Layout Validation

Status: ready
Owner: Tom
Updated: 2026-07-20
Milestone: `../001-project-scoped-workspace-layouts.md`
Auto-start next card: no

## Objective

Prove project layout isolation and the minimal new-project shell in the native
app before moving further inward.

## Acceptance

- [x] automated persistence, migration, desktop, and docs checks pass
- [ ] operator confirms two projects retain visibly different layouts
- [ ] operator confirms a new project opens with Agent Chat only

## Stop Conditions

- project switching flashes or temporarily mutates the previous project layout
- native window position or project-rail width changes per project
- a new project opens Tasks, Terminal, Memory, or another optional panel
