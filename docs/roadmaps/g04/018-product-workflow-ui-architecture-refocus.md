# 018 Product Workflow UI Architecture Refocus

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Stop the disposable proof UI from becoming the product UI and define the first
real Nucleus selected-task workflow surface.

The server/control work remains valuable, but the next implementation should
line up with how users will actually move through the app.

## Governing Refs

- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `017-selected-task-delegation-scheduling-admission.md`

## Goals

- [x] Freeze the disposable task workflow proof as diagnostic-only.
- [x] Define the first real selected-task workflow information architecture.
- [x] Decide which existing server surfaces are product-facing versus
  diagnostic-only.
- [x] Decide whether a selected-task workflow aggregate query is needed before
  more UI controls.
- [x] Recompile the next implementation lane around the real workflow surface.

## Execution Plan

- [x] Batch 1: freeze proof UI and record product workflow UI boundaries.
- [x] Batch 2: selected-task workflow shell architecture.
- [x] Batch 3: server surface fit and aggregate-query decision.
- [x] Batch 4: implementation runway reset.
- [x] Batch 5: validation and resume/pause decision for delegation scheduling.

## Batch Cards

Completed cards:

- `batch-cards/085-proof-ui-freeze-and-product-workflow-boundary.md`
- `batch-cards/086-selected-task-workflow-shell-architecture.md`
- `batch-cards/087-selected-task-server-surface-fit.md`
- `batch-cards/088-product-workflow-implementation-runway-reset.md`
- `batch-cards/089-ui-refocus-validation-next-lane.md`

## Boundary

This lane may:

- document product UI architecture
- classify proof-only versus product-facing surfaces
- define component boundaries and workflow stages
- defer or reshape implementation cards that would add proof UI debt
- identify server aggregate query needs

This lane must not:

- implement final UI visuals
- add more controls to the disposable proof by default
- mutate server state
- start provider execution
- redesign unrelated project, memory, planning, SCM, or settings surfaces

## Decision Notes

The selected-task proof has validated the server contract but is now too dense
to grow safely. The right next step is to design the user-facing workflow
surface before delegation scheduling or other mutation-capable controls are
added.

The first real selected-task shell must sit inside the previously documented
display/window/surface/region/panel hosting hierarchy. The next lane is
workspace hosting model extraction from Loophole/Echo into
`nucleus-workspaces`, before final shell implementation resumes.
