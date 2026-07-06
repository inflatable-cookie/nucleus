# 003 Task Workflow Drilldown And Handoff Readiness

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Make the product workflow summary actionable by giving a selected task or next
step a read-only drilldown over existing task, timeline, runtime, review, and
SCM handoff evidence.

The source-composed summary answers what exists. This lane answers why a task
or handoff is next, what evidence supports it, and what remains blocked without
turning the proof UI into the authority.

## Governing Refs

- `docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`
- `docs/roadmaps/g04/002-product-workflow-source-composition.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`
- `docs/architecture/server-client-gap-matrix.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the read-only task workflow drilldown boundary and source map.
- [x] Compose a server-owned drilldown read model for one project task or
  product workflow next ref.
- [x] Expose the drilldown through control DTOs, `nucleusd`, and Effigy.
- [x] Add a disposable desktop proof path that consumes the server drilldown.
- [x] Keep review, SCM handoff, task mutation, provider execution, and final UI
  work separate.

## Execution Plan

- [x] Batch 1: drilldown boundary, source map, and stop conditions.
- [x] Batch 2: task workflow drilldown read model.
- [x] Batch 3: CLI and Effigy inspection surface.
- [x] Batch 4: disposable desktop drilldown proof.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/011-task-workflow-drilldown-boundary.md`
- `batch-cards/012-task-workflow-drilldown-read-model.md`
- `batch-cards/013-task-workflow-drilldown-cli-effigy.md`
- `batch-cards/014-disposable-task-workflow-drilldown-proof.md`
- `batch-cards/015-task-workflow-drilldown-validation-next-lane.md`

## Boundary

This lane may:

- summarize existing task records, task readiness, task timeline entries,
  work-progress refs, runtime receipts, command evidence refs, review refs,
  and SCM readiness refs for one selected task or next ref
- add a read-only server query and serialized DTO if the source map proves the
  shape is stable
- add `nucleusd`, Effigy, and disposable desktop proof consumption
- show missing source families as explicit gaps

This lane must not:

- mutate tasks, work items, planning artifacts, memory, SCM, forge, provider,
  or UI state
- start provider execution or schedule agents
- accept, reject, complete, abandon, rework, publish, push, open PRs, merge,
  snapshot, or apply imports
- expose raw transcripts, raw command output, raw provider payloads, secrets,
  credentials, or terminal streams
- reopen accepted-memory active apply, planning active apply, provider
  live-read expansion, or Convergence backend execution
- turn the disposable desktop proof into final UI design

## Source Map

The first drilldown source map is task-scoped.

Primary identity:

- project id from the query
- task id from the query or product workflow `next.next_ref` when the next
  source is `task`
- task record from server task storage, accepted only when the task belongs to
  the queried project

Task and readiness sources:

- task storage records decoded through `nucleus-tasks`
- task readiness candidate classification from
  `EngineTaskReadinessProjection`
- product workflow next source only when it names the same task

Timeline sources:

- `EngineTaskTimelineProjection::rebuild`
- `request_handler/queries/task_timeline.rs`
- `nucleusd query task-timeline --task <task-id>`

Timeline refs are admitted only when `entry.task_id` equals the selected task.
The current limitation remains visible: project-scoped task creation events may
not appear in the task-scoped timeline until later task events target the
concrete task id.

Work-progress sources:

- `read_task_agent_work_unit_source_records`
- `project_task_agent_work_units`
- `TaskAgentWorkUnitDiagnosticDto`
- runtime metadata `ListTaskWorkProgress`

The current list query is global. The drilldown read model must filter work
units by both `project_id` and `task_id` before counting or exposing refs.

Runtime evidence sources:

- runtime receipts through `read_runtime_receipts`
- command evidence through command-evidence storage
- live-evidence task completions through
  `read_live_evidence_task_completions`
- checkpoint and diff refs only when linked from task work refs or review
  records

Generic runtime receipts and command evidence are not task-scoped by default.
They may enter the drilldown only through a selected task work unit, task
completion, review, or explicit task-linked evidence ref.

Review sources:

- live-evidence review decisions through
  `read_live_evidence_review_decisions`
- task-agent work-unit review status from projected source records
- work-item review refs only when task and project match

Review acceptance remains evidence. It must not complete the task or admit SCM
publication.

SCM handoff sources:

- completion SCM capture admission and preparation records
- SCM capture dry-run plan and execution receipt records
- SCM capture review decisions
- SCM change-request prep records

Only SCM records carrying the selected `task_id` may appear. Git dry-run
execution records that lack task identity must not be pulled into a task
drilldown unless linked through a task-scoped SCM record.

## Drilldown Shape

The first read model should be coarse:

- `project_id`
- `task_id`
- `task`: title, status, action type, assignment/activity labels where
  available
- `readiness`: lane, rationale refs, blocker refs
- `timeline`: entry count, entry refs, last source event id
- `work_progress`: work item refs, runtime labels, review labels, issue refs
- `runtime`: runtime receipt refs, command evidence refs, checkpoint refs,
  diff summary refs, validation refs, artifact refs
- `review`: review refs, review status labels, missing-review gaps
- `scm_handoff`: SCM readiness refs, change-request prep refs, missing-handoff
  gaps
- `next`: known next source/ref or blocked reason
- `source_counts`
- `gaps`
- `no_effects`

All arrays should contain stable refs, not raw payloads.

## Gap Rules

Initial gap areas:

- `task_missing`: no selected task exists for the project
- `readiness_missing`: no readiness candidate exists for the selected task
- `timeline_missing`: no task-scoped timeline entries exist
- `work_progress_missing`: no task-agent work units exist for the task
- `runtime_missing`: no linked runtime, command, checkpoint, diff, validation,
  or artifact refs exist
- `review_missing`: no review state or review evidence exists
- `scm_handoff_missing`: no task-scoped SCM readiness or handoff refs exist
- `next_missing`: no next pathway source exists for the selected task

Missing gaps are explanatory. They must not create fake readiness.

## Surface Names

Later cards may add these surfaces:

- server query: `TaskWorkflowDrilldown`
- control query DTO: `task_workflow_drilldown`
- response DTO: `TaskWorkflowDrilldown`
- CLI: `nucleusd query task-workflow-drilldown --project <project-id> --task
  <task-id>`
- Effigy selector: `server:query:task-workflow-drilldown`
- desktop command: `queryTaskWorkflowDrilldown`
- disposable proof panel: `TaskWorkflowDrilldownProofPanel.svelte`

The initial CLI requires both project and task ids. Product-summary driven
selection can come later once the direct shape is stable.

## Leakage Rules

The drilldown must fail closed on identity ambiguity.

- task records must match the selected project
- timeline entries must match the selected task
- work-progress records must match selected project and task
- review and completion records must match selected task
- SCM records must match selected task
- runtime receipts, command evidence, checkpoint refs, diff refs, validation
  refs, and artifact refs may appear only through an accepted task-scoped
  source edge
- global diagnostics may contribute counts only after task filtering

## Stop Conditions

Stop before implementation if:

- the selected source cannot prove task/project ownership
- implementing the read model requires task mutation, provider execution, SCM
  mutation, memory apply, planning apply, or final UI design
- the source map depends on a deferred lane in `docs/roadmaps/deferred-lanes.md`
- the proposed DTO would need raw provider payloads, command output, terminal
  streams, secrets, or credential material
- the next step would be inferred from a generic guess instead of task,
  timeline, review, SCM, planning, roadmap, goal, or operator evidence

## Acceptance Criteria

- [ ] A selected task or next ref can be explained from existing server-owned
  records.
- [ ] Missing drilldown sources are visible and do not create fake readiness.
- [ ] Server, CLI, Effigy, and desktop surfaces remain read-only.
- [ ] Deferred subsystem lanes remain deferred unless this lane proves a real
  product blocker.
