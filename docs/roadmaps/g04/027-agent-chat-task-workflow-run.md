# 027 Agent Chat Goal Workflow Run

Status: completed
Owner: Tom
Updated: 2026-07-10

## Purpose

Make one task or one durable Goal genuinely executable from Agent Chat through
a single `task_workflow` portal and an explicit conversation mandate.

## Boundary

This lane may:

- create durable goal records and ordered task membership
- group the Tasks panel by goal while retaining ungrouped tasks
- let `task_ledger` inspect, create, and refine goals without another tool
- persist the current operator turn before provider tools execute
- create a goal-scoped, auditable conversation mandate
- inspect task workflow readiness through a product-shaped server view
- compose dependency, revision, route, work-item, and dispatch admission
- execute one local Codex-backed task at a time
- show compact started, blocked, stopped, and recovery receipts

This lane must not:

- expose internal delegation, scheduling, adapter-selection, or lifecycle stages
  as agent tools or portal actions
- treat a scheduled work item as successful execution
- infer run authority from task creation, readiness, selection, or assistant text
- execute an arbitrary task array or sweep all project-ready tasks
- add persistent project autonomy, parallel runway execution, SCM publication,
  automatic review acceptance, or automatic task completion
- expand the approved workspace shell or proof modal

## Sequencing

The portal is registered only after the server can reach provider dispatch.
Earlier cards build and validate the internal chain without exposing partial
workflow behavior to the agent.

## Batch Cards

Ready:

- None.

Planned:

- None.

Completed:

- `batch-cards/149-task-workflow-portal-receipts-and-live-validation.md`
- `batch-cards/148-goal-run-provider-dispatch-bridge.md`
- `batch-cards/147-goal-run-inspection-and-admission.md`
- `batch-cards/146-goal-mandate-turn-start-boundary.md`
- `batch-cards/143-goal-domain-and-task-membership.md`
- `batch-cards/144-task-ledger-goal-authoring.md`
- `batch-cards/145-goal-grouped-task-panel-and-chat-context.md`
