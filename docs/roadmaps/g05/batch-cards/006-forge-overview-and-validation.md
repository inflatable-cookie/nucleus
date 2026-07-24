# 006 Forge Overview And Validation

Status: ready
Owner: Tom
Updated: 2026-07-24
Milestone: `../002-workspace-sidebar-modes.md`
Auto-start next card: no

## Objective

Add a compact cross-project repository inventory as the honest starting point
for a later VS Code-like Forge workflow, then validate the complete sidebar.

## Acceptance

- [x] Forge lists Git resources grouped by project
- [x] repository rows expose recorded health and default-branch hints only
- [x] no commit, stage, push, refresh, or forge effect is implied
- [ ] operator confirms all four views remain compact and distinct

## Validation

- desktop type check, focused tests, production build, and docs QA
- native switching across projects and sidebar modes

## Stop Conditions

- recorded metadata is presented as live Git status
- mutation controls outrun SCM and forge admission contracts
- Forge is scoped only to the selected project
