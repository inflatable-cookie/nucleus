# 199 Shared Project Files Validation

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../041-shared-project-files-control.md`
Auto-start next card: no

## Objective

Validate management resource binding, export/import, repair, conflict, sync
policy, and no-projection behavior.

## Acceptance

- [x] focused management projection, persistence, desktop, and docs checks pass
- [x] disabling or losing the projection does not lose active project state
- [x] multi-repo projects project one coherent membership set
- [x] operator confirms the feature remains advanced and optional

## Evidence

- 57 focused management-projection tests pass.
- The bound resource proof covers persistence, export, import staging, missing
  repository repair, detach, and removal without making projected files active
  state.
- Desktop type checks and 14 focused client tests pass.
- Docs QA and diff hygiene pass.
- The operator confirmed the project-menu surface remains advanced and
  optional on 2026-07-20.

## Operator Check

From a project's overflow menu, open Shared project files. Confirm it stays out
of New project and New chat, offers only attached Git resources, clearly says
Nucleus remains authoritative, and can configure then disable the projection
without affecting the project.

## Stop Conditions

- projected files become active runtime authority
- the client accepts or invents a repository path
- one project can configure multiple active projection targets
