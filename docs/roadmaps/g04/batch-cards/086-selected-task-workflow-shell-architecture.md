# 086 Selected Task Workflow Shell Architecture

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../018-product-workflow-ui-architecture-refocus.md`

## Purpose

Define the first real selected-task workflow shell before implementation.

## Work

- [x] Define primary regions for project rail, task list, selected-task stage,
  action rail, and evidence/review panel.
- [x] Define interaction order from project selection through task action,
  evidence, review, rework, completion, and SCM handoff readiness.
- [x] Define what must be visible without opening diagnostics.
- [x] Define responsive and multi-surface constraints without final visuals.

## Acceptance Criteria

- [x] The shell can be implemented without using the proof modal as product UI.
- [x] The first workflow is task-centered and project-aware.
- [x] UI authority boundaries remain server-owned.

## Result

The first real shell is task-centered and project-aware:

- left project/activity rail
- task list and filters
- selected-task stage with one primary next action
- action rail for admitted and blocked actions
- persistent evidence/review/SCM readiness panel

The shell is not the whole workspace model. It must be a panel set hosted
inside the global display/window/surface hierarchy recorded in
`docs/contracts/006-workspace-layout-contract.md`.

The first desktop implementation may start as one window and one hosted
surface, but the model must keep display/window/surface identity out of the
renderer and out of committable project files.
