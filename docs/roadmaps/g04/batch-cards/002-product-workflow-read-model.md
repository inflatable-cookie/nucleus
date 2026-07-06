# 002 Product Workflow Read Model

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../001-product-workflow-rebaseline-and-vertical-slice.md`

## Purpose

Compose a read-only server-owned product workflow summary from existing
records.

## Work

- [x] Define workflow summary types and counts.
- [x] Read existing project, task, planning, memory, runtime, review, and SCM
  readiness records.
- [x] Preserve sanitized refs instead of raw payloads.
- [x] Add focused read-model tests.
- [x] Report missing source records as explicit gaps instead of invented state.
- [x] Include no-effect flags for task, provider, SCM/forge, accepted-memory
  apply, projection write, agent scheduling, and UI behavior.

## Result

Added `nucleus-server::product_workflow_summary` as a read-only server-owned
model that composes normalized source refs, lane counts, source counts, next
step data, explicit gaps, and no-effect flags. The model is pure and does not
query, mutate, schedule, execute providers, write projections, or perform UI
effects.

## Acceptance Criteria

- [x] The read model explains workflow state without mutation.
- [x] Missing source records produce explicit gaps, not invented state.
- [x] Clients remain non-authoritative.
- [x] The model stays useful from CLI output without requiring final UI.
