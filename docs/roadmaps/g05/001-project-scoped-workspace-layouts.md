# 001 Project-Scoped Workspace Layouts

Status: active
Owner: Tom
Updated: 2026-07-20

## Purpose

Make project switching restore that project's open tabs, panel placement,
active tabs, and region sizing. Keep native window placement and project-rail
width global.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../architecture/project-resource-lifecycle.md`

## Execution Plan

- [x] Replace the single persisted panel layout with global native-window state
  plus layouts keyed by project id.
- [x] Bind panel creation, close, move, reorder, focus, resource selection, and
  split sizing to the selected project.
- [x] Migrate the current global layout once and give previously unseen projects
  a single Agent Chat panel.
- [ ] Validate restart persistence, project isolation, rapid switching, and the
  minimal new-project shape.

## Goals

- [x] switching projects switches the complete working layout
- [x] changes in one project cannot mutate another project's layout
- [x] new projects start with Agent Chat only
- [x] native window geometry remains global and host-owned

## Acceptance Criteria

- [x] schema migration preserves the existing layout for one current project
- [x] two projects retain distinct panels, regions, active tabs, and split ratios
- [x] a newly created project contains exactly one Agent Chat tab
- [x] desktop checks, focused Rust tests, client tests, and docs QA pass

## Batch Cards

Ready:

- `batch-cards/003-project-layout-validation.md`

Completed:

- `batch-cards/001-project-layout-store-and-migration.md`
- `batch-cards/002-project-layout-desktop-binding.md`
