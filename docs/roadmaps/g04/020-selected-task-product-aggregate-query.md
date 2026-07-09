# 020 Selected Task Product Aggregate Query

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Create one product-facing selected-task workflow aggregate so the real UI shell
does not depend on a pile of proof-first query calls.

The aggregate should compose existing server-owned task workflow, readiness,
command, review, route, rework, completion, evidence, and SCM handoff records
into one read-only product model.

## Governing Refs

- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g04/019-workspace-hosting-model-extraction.md`

## Goals

- [x] Define the selected-task aggregate contract and field groups.
- [x] Compose the aggregate from existing read-only server surfaces.
- [x] Add control DTO, `nucleusd`, and Effigy inspection.
- [x] Add a product client adapter boundary separate from proof UI helpers.
- [x] Keep proof modal diagnostic-only.

## Execution Plan

- [x] Batch 1: aggregate contract and source map.
- [x] Batch 2: server read model composition.
- [x] Batch 3: control DTO and request handler integration.
- [x] Batch 4: `nucleusd` and Effigy inspection.
- [x] Batch 5: product client adapter shape.
- [x] Batch 6: validation and product shell lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/097-selected-task-aggregate-contract.md`
- `batch-cards/098-selected-task-aggregate-read-model.md`
- `batch-cards/099-selected-task-aggregate-control-dto.md`
- `batch-cards/100-selected-task-aggregate-cli-effigy.md`
- `batch-cards/101-selected-task-aggregate-product-client-adapter.md`
- `batch-cards/102-selected-task-aggregate-validation-next-lane.md`

## Boundary

This lane may:

- add read-only server query types and DTOs
- add pure composition code over existing selected-task surfaces
- add CLI/Effigy inspection
- add product client adapter helpers

This lane must not:

- mutate task state
- start delegation scheduling
- add new proof modal controls
- implement final product visuals
- execute providers, SCM, terminal, browser, editor, or forge actions

## Decision Notes

The aggregate should be product-shaped, not a raw DTO dump. It should expose
the primary next action, blockers, unavailable actions, evidence/review state,
completion/rework route previews, and SCM handoff readiness in user-facing
groups while preserving server authority.

Paused after operator correction: the immediate product UI step is the project
rail and shell layout, not selected-task aggregate composition.

Unpaused after `021-product-shell-project-rail`: the normal shell now has
project selection, active workspace state, and read-only task navigation. The
aggregate is the next blocker for moving richer selected-task workflow state
out of the proof modal.

Card 097 promoted the selected-task aggregate rule into
`docs/contracts/023-task-backed-agent-workflow-contract.md` and aligned
`docs/architecture/product-workflow-ui-architecture.md`. The next batch should
implement the read-only server read model from that field-group/source-map
contract.

Card 098 added the pure server read model in
`crates/nucleus-server/src/selected_task_product_aggregate/`. The next batch
should expose it through the control DTO/query boundary without changing proof
modal behavior.

Card 099 exposed the aggregate through the server control query, request DTO,
response DTO, and local request handler while preserving read-only semantics.

Card 100 added `nucleusd query selected-task-product-aggregate`, the Effigy
selector, focused CLI/rendering tests, and product-shaped output that avoids raw
proof payload dumps.

Card 101 added the desktop product client adapter boundary for the aggregate
without moving proof helper APIs into the normal shell.

Card 102 validated the lane and selected the next product-shell step: render a
read-only selected-task aggregate panel in the normal workspace stage.
