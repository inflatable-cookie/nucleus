# g04 Product Workflow Vertical Slice

Status: active
Owner: Tom
Updated: 2026-07-06

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
- the active path is now source composition for existing planning, context,
  runtime, review, SCM, and next-step records

## Roadmaps

- `001-product-workflow-rebaseline-and-vertical-slice.md` - completed
- `002-product-workflow-source-composition.md` - ready

## Batch Cards

Ready cards:

- `batch-cards/006-product-workflow-planning-context-composition.md`

Planned cards:

- `batch-cards/007-product-workflow-memory-research-composition.md`
- `batch-cards/008-product-workflow-runtime-review-composition.md`
- `batch-cards/009-product-workflow-scm-next-composition.md`
- `batch-cards/010-product-workflow-source-composition-validation.md`

Completed cards:

- `batch-cards/001-product-workflow-lane-boundary.md`
- `batch-cards/002-product-workflow-read-model.md`
- `batch-cards/003-product-workflow-cli-effigy-inspection.md`
- `batch-cards/004-disposable-product-workflow-proof.md`
- `batch-cards/005-product-workflow-validation-next-lane.md`
