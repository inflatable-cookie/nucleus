# 004 Disposable Product Workflow Proof

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../001-product-workflow-rebaseline-and-vertical-slice.md`

## Purpose

Add a disposable desktop proof surface if the server read model is useful.

## Work

- [x] Consume the read-only workflow summary through existing client command
  paths.
- [x] Show project/task/planning/runtime/review/SCM readiness state in one
  proof surface.
- [x] Keep visual design disposable and avoid panel-system commitments.
- [x] Add focused desktop checks only around data consumption and non-empty
  rendering.

## Result

Added a disposable `ProductWorkflowProofPanel` to the desktop shell. It consumes
the server-owned `product_workflow_summary` control query through the existing
Tauri IPC path and shows project identity, task lanes, source counts, gaps,
next-step status, and no-effect flags.

The panel is intentionally not a final layout, panel-system, editor, plugin, or
client-authority surface. A plain browser/Vite render shows the panel shell but
cannot call Tauri IPC outside the Tauri runtime; the meaningful consumption
proof is covered by focused Tauri route tests.

## Acceptance Criteria

- [x] The UI proves the workflow is understandable.
- [x] The UI does not become state authority.
- [x] No final design, panel layout, editor, plugin runtime, provider effect,
  SCM/forge mutation, task mutation, or accepted-memory apply behavior is
  added.
