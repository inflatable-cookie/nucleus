# 006 Forge Overview And Validation

Status: completed
Owner: Tom
Updated: 2026-07-25
Milestone: `../002-workspace-sidebar-modes.md`
Auto-start next card: no

## Objective

Add a compact cross-project repository inventory as the honest starting point
for a later VS Code-like Forge workflow, then validate the complete sidebar.

## Acceptance

- [x] Forge lists Git resources grouped by project
- [x] repository rows expose recorded health and default-branch hints only
- [x] no commit, stage, push, refresh, or forge effect is implied
- [x] operator confirms all four views remain compact and distinct

## Closeout

The operator checkpointed the sidebar work at Nucleus
`7502b761e0a31fb8c3833d2777b068f3f8f998a9`. That closes the overlap gate for
the Swallowtail proof-readiness lane. Later uncommitted project-rename
refinement remains outside this card.

## Validation

- desktop type check, focused tests, production build, and docs QA
- native switching across projects and sidebar modes

## Stop Conditions

- recorded metadata is presented as live Git status
- mutation controls outrun SCM and forge admission contracts
- Forge is scoped only to the selected project
