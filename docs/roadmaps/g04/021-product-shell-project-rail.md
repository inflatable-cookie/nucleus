# 021 Product Shell Project Rail

Status: completed
Owner: Tom
Updated: 2026-07-08

## Purpose

Start the real product shell from the left project rail before selected-task
aggregate work resumes.

The project rail is the first product navigation surface: projects are durable
entities, active work appears under expanded projects, and the central
workspace stays empty until the higher-level workflow is designed.

## Governing Refs

- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/006-workspace-layout-contract.md`
- `docs/roadmaps/g04/019-workspace-hosting-model-extraction.md`

## Goals

- [x] Render project rows in the left rail.
- [x] Make project row clicks activate the project and toggle expansion.
- [x] Show project-linked active work under expanded projects.
- [x] Wire the main workspace stage to the active project.
- [x] Keep proof harness isolated.

## Execution Plan

- [x] Batch 1: project rail list and active-work dropdown.
- [x] Batch 2: active project workspace stage skeleton.
- [x] Batch 3: task list placement decision, later superseded.
- [x] Batch 4: product shell validation and next lane selection.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/103-product-shell-project-rail-list.md`
- `batch-cards/104-active-project-workspace-stage.md`
- `batch-cards/106-product-shell-validation-next-lane.md`

Superseded cards:

- `batch-cards/105-product-shell-task-list-placement.md`

## Boundary

This lane may:

- build product-shell Svelte components
- consume existing read-only project and work-progress queries
- shape the left rail and central workspace skeleton

This lane must not:

- add mutation-capable controls
- make proof UI the product UI
- implement selected-task aggregate server work
- implement final visual design beyond the current Poodle dark shell baseline

## Decision Notes

The project rail and blank active workspace stage remain the durable baseline.
The attempted task list placement was removed from the normal workspace after
operator correction because the higher-level workflow must be designed before
tasks make it onto the screen.
