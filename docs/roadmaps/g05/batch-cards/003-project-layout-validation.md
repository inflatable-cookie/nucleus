# 003 Project Layout Validation

Status: complete
Owner: Tom
Updated: 2026-08-01
Milestone: `../001-project-scoped-workspace-layouts.md`
Auto-start next card: no

## Objective

Prove project layout isolation and the minimal new-project shell in the native
app before moving further inward.

## Acceptance

- [x] automated persistence, migration, desktop, and docs checks pass
- [x] operator confirms two projects retain visibly different layouts
- [x] operator confirms a new project opens with Agent Chat only

## Operator Evidence

- Cross-project layout retention accepted in native use.
- A newly created, previously unseen project opened with exactly one Agent
  Chat panel and no optional panel.
- No stop condition was observed.

## Stop Conditions

- project switching flashes or temporarily mutates the previous project layout
- native window position or project-rail width changes per project
- a new project opens Tasks, Terminal, Memory, or another optional panel
