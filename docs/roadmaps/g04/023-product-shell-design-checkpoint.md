# 023 Product Shell Design Checkpoint

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Pause product-shell expansion long enough for operator design direction before
more UI is added.

The normal shell now has a project rail, titlebar, proof-harness launcher, and
an intentionally empty workspace. Task and aggregate panels were removed from
the normal workspace because the higher-level workflow must be designed before
tasks make it onto the screen.

The intended direction is chat-led and task-backed. Agent chat is the primary
interaction surface; tasks are the structured ledger and can be managed by
agents through server-authorized tools. The task panel is an uncloseable system
tab, defaulted to `centerTop` and only movable to `centerBottom` in the first
model.

## Governing Refs

- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/006-workspace-layout-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g04/022-selected-task-aggregate-product-shell-placement.md`

## Goals

- [x] Review the current shell through the running Tauri app.
- [x] Capture operator UI direction before more product shell implementation.
- [x] Promote stable design decisions into architecture/contract notes.
- [x] Select the next bounded product UI or workflow lane.

## Execution Plan

- [x] Batch 1: run-app design review checkpoint.
- [x] Batch 2: promote design decisions and select next lane.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/111-product-shell-design-review-checkpoint.md`
- `batch-cards/112-product-shell-design-direction-promotion.md`

## Boundary

This lane may:

- run the app and inspect current shell behavior
- capture product-shell layout, hierarchy, and workflow direction
- document which UI pieces are throwaway, provisional, or durable
- choose the next bounded product UI/workflow lane
- keep the central workspace empty until that direction is explicit
- preserve the four-region model: `left`, `right`, `centerTop`, `centerBottom`

This lane must not:

- keep adding speculative widgets
- add task mutation controls
- schedule delegation
- implement final visual design without operator direction

## Decision Notes

This checkpoint is intentional. The product shell is now concrete enough to
review at the shell level, and adding task/workflow UI without operator design
direction caused noise. The central workspace is blank again.

No generic bottom region should be introduced. Terminal, browser, editor, diff,
agent chat, and task panels belong in `centerTop` or `centerBottom`; contextual
logs/output belong inside their owning panel or in `right`.

Next selected lane: workspace surface shell skeleton.
