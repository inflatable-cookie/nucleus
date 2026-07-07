# g04 Product Workflow Vertical Slice

Status: active
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn the large set of server proofs from g01-g03 into a coherent product
workflow.

G04 is not another subsystem-deepening generation. Its job is to prove that a
user can move through a Nucleus-shaped project workflow: select a project,
inspect tasks and planning context, delegate bounded work, watch evidence,
review results, and understand the next step without clients becoming state
authorities.

## Generation Runway

Current generation goal:

- prove a product-shaped workflow across project, task, planning, agent
  runtime, evidence, review, and SCM readiness surfaces before widening memory,
  provider, SCM, panel, or final UI implementation

Current runway bands:

- product workflow rebaseline and vertical-slice selection
- server-side workflow summary/read model over existing records
- `nucleusd` and Effigy inspection for the workflow summary
- disposable desktop proof surface that shows the workflow without final UI
  commitments
- task-backed agent work loop hardening from existing Codex/runtime evidence
- review/acceptance/next-task presentation without automatic task mutation
- SCM readiness handoff as a practical user workflow, not more provider
  execution
- deferred-lane checkpoints for memory, provider, SCM, panel, and UI work

Current checkpoint:

- g03 closed after accepted-memory review receipt persistence and stopped
  active-apply admission diagnostics
- accepted-memory active apply executor is superseded and deferred
- `docs/roadmaps/deferred-lanes.md` tracks valid return-later lanes
- the first product workflow slice is validated
- source composition for existing planning, context, runtime, review, SCM, and
  next-step records is validated
- the task workflow drilldown boundary, read model, DTOs, CLI, and Effigy
  selector are validated
- the disposable desktop proof for the selected-task drilldown is in place
- the task workflow drilldown lane is validated and the next lane is selected
- the active path is selected-task work-loop composition
- the selected-task work-loop boundary and source map are defined
- selected-task read-only guidance is now part of the task workflow drilldown
- the disposable desktop proof now composes selected task, project workflow,
  guidance, review readiness, and handoff readiness
- selected-task work-loop composition is validated
- the active path is selected-task action readiness
- the selected-task action readiness boundary and read model are in place
- selected-task action readiness has CLI, control DTO, and Effigy inspection
- selected-task action readiness is visible in the disposable desktop proof
- selected-task action readiness is validated
- the active path is selected-task operator action gate
- selected-task operator task-action boundary and read-only gate are in place
- selected-task operator action gate has CLI and Effigy inspection
- selected-task operator action gate is visible in the disposable desktop proof
- selected-task operator action gate is validated
- the active path is selected-task task-command admission controls
- selected-task command admission boundary and server proof are in place
- selected-task command admission has CLI and Effigy dry-run inspection
- selected-task command admission has disposable desktop proof controls
- selected-task command admission is validated
- the active path is task-command outcome coherence
- task-command shell refresh boundary is in place

## Roadmaps

- `001-product-workflow-rebaseline-and-vertical-slice.md` - completed
- `002-product-workflow-source-composition.md` - completed
- `003-task-workflow-drilldown-and-handoff-readiness.md` - completed
- `004-selected-task-work-loop-composition.md` - completed
- `005-selected-task-action-readiness.md` - completed
- `006-selected-task-operator-action-gate.md` - completed
- `007-selected-task-command-admission-controls.md` - completed
- `008-task-command-outcome-coherence.md` - active

## Batch Cards

Ready cards:

- `batch-cards/037-task-command-desktop-refresh-loop.md`

Planned cards:

- `batch-cards/038-task-command-receipt-timeline-presentation.md`
- `batch-cards/039-task-command-outcome-validation-next-lane.md`

Completed cards:

- `batch-cards/001-product-workflow-lane-boundary.md`
- `batch-cards/002-product-workflow-read-model.md`
- `batch-cards/003-product-workflow-cli-effigy-inspection.md`
- `batch-cards/004-disposable-product-workflow-proof.md`
- `batch-cards/005-product-workflow-validation-next-lane.md`
- `batch-cards/006-product-workflow-planning-context-composition.md`
- `batch-cards/007-product-workflow-memory-research-composition.md`
- `batch-cards/008-product-workflow-runtime-review-composition.md`
- `batch-cards/009-product-workflow-scm-next-composition.md`
- `batch-cards/010-product-workflow-source-composition-validation.md`
- `batch-cards/011-task-workflow-drilldown-boundary.md`
- `batch-cards/012-task-workflow-drilldown-read-model.md`
- `batch-cards/013-task-workflow-drilldown-cli-effigy.md`
- `batch-cards/014-disposable-task-workflow-drilldown-proof.md`
- `batch-cards/015-task-workflow-drilldown-validation-next-lane.md`
- `batch-cards/016-selected-task-work-loop-boundary.md`
- `batch-cards/017-selected-task-work-loop-guidance-read-model.md`
- `batch-cards/018-selected-task-work-loop-desktop-composition.md`
- `batch-cards/019-review-scm-handoff-gap-presentation.md`
- `batch-cards/020-selected-task-work-loop-validation-next-lane.md`
- `batch-cards/021-selected-task-action-readiness-boundary.md`
- `batch-cards/022-selected-task-action-readiness-read-model.md`
- `batch-cards/023-selected-task-action-readiness-cli-effigy.md`
- `batch-cards/024-selected-task-action-readiness-desktop-proof.md`
- `batch-cards/025-selected-task-action-readiness-validation-next-lane.md`
- `batch-cards/026-selected-task-operator-action-boundary.md`
- `batch-cards/027-selected-task-operator-action-gate-read-model.md`
- `batch-cards/028-selected-task-operator-action-cli-effigy.md`
- `batch-cards/029-selected-task-operator-action-desktop-proof.md`
- `batch-cards/030-selected-task-operator-action-validation-next-lane.md`
- `batch-cards/031-selected-task-command-admission-boundary.md`
- `batch-cards/032-selected-task-command-admission-proof.md`
- `batch-cards/033-selected-task-command-cli-effigy.md`
- `batch-cards/034-selected-task-command-desktop-proof-controls.md`
- `batch-cards/035-selected-task-command-validation-next-lane.md`
- `batch-cards/036-task-command-refresh-boundary.md`
