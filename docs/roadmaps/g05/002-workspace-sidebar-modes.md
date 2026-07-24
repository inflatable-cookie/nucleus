# 002 Workspace Sidebar Modes

Status: active
Owner: Tom
Updated: 2026-07-24

## Purpose

Replace the mixed project rail with four focused sidebar modes: Projects,
Threads, Files, and Forge. Keep the first slice sparse and read-oriented while
preserving project selection and the existing project-management controls.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../architecture/project-resource-lifecycle.md`

## Execution Plan

- [x] Add the global sidebar tab shell and reduce Projects to project concerns.
- [x] Add initial Threads and project-resource Files views using existing read
  boundaries.
- [x] Add the first cross-project Forge repository overview without SCM
  mutation controls.
- [ ] Validate switching, project continuity, file opening, and compact states.

## Goals

- [x] each sidebar mode has one clear responsibility
- [x] changing sidebar modes does not change the selected project
- [x] Files separates the selected project's filesystem resources
- [x] Forge starts as a cross-project repository overview

## Acceptance Criteria

- [x] Projects, Threads, Files, and Forge are keyboard-accessible tabs
- [x] existing project creation, lifecycle, and resource management remain in
  the mounted Projects view
- [x] selecting a file opens or focuses an Editor panel for the correct resource
- [x] desktop checks, focused client tests, production build, and docs QA pass

## Batch Cards

Ready:

- `batch-cards/006-forge-overview-and-validation.md`

Completed:

- `batch-cards/004-sidebar-tab-shell-and-projects.md`
- `batch-cards/005-threads-and-files-foundation.md`
