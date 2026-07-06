# 004 Selected Task Work Loop Composition

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Turn the selected-task drilldown into a coherent product loop.

The task workflow drilldown proves the server can answer what exists for one
task. This lane should make that answer usable: why this task is next, what
evidence exists, what is missing, what review or SCM handoff would be needed,
and what action remains safe.

## Governing Refs

- `docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`
- `docs/roadmaps/g04/002-product-workflow-source-composition.md`
- `docs/roadmaps/g04/003-task-workflow-drilldown-and-handoff-readiness.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the selected-task work-loop boundary and stop conditions.
- [x] Compose the task workflow proof into a clearer client-facing path.
- [x] Surface review and SCM handoff gaps as next-action evidence, not fake
  readiness.
- [x] Keep provider execution, SCM mutation, active memory apply, planning
  active apply, and final UI design out of scope.
- [x] Choose the next product lane from evidence, not subsystem completion.

## Execution Plan

- [x] Batch 1: selected-task work-loop boundary and source map.
- [x] Batch 2: server/client read-model shape for work-loop action guidance.
- [x] Batch 3: disposable desktop composition over existing proof panels.
- [x] Batch 4: review and SCM handoff gap presentation.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/016-selected-task-work-loop-boundary.md`
- `batch-cards/017-selected-task-work-loop-guidance-read-model.md`
- `batch-cards/018-selected-task-work-loop-desktop-composition.md`
- `batch-cards/019-review-scm-handoff-gap-presentation.md`
- `batch-cards/020-selected-task-work-loop-validation-next-lane.md`

## Boundary

This lane may:

- use existing project, task, product workflow, task workflow drilldown,
  readiness, timeline, work-progress, runtime, review, and SCM handoff records
- add read-only guidance fields when the selected-task path needs a clearer
  next step
- improve disposable desktop composition so selected task context is easier to
  follow
- expose missing evidence as gaps
- recommend an operator next action without executing it

This lane must not:

- mutate tasks, work items, planning artifacts, memory, SCM, forge, provider,
  or UI authority state
- start provider execution, schedule agents, run SCM mutation, create commits,
  push, open PRs, merge, snapshot, or publish
- apply accepted memory or planning imports into active state
- add raw transcript, raw command output, raw provider payload, secret,
  credential, or terminal stream exposure
- turn disposable proof panels into final UI design

## Product Question

At the end of this lane, the disposable proof should answer:

- what task is selected
- why it is or is not the next task
- what work evidence exists
- what review evidence exists
- what SCM handoff evidence exists
- what is missing
- what safe next action the operator can take

If the answer requires execution, mutation, or final UI decisions, this lane
should stop at readiness and route that work into a fresh roadmap.

## Current Selected-Task Path

The current desktop proof path is split across panels:

- `App.svelte` owns `selectedProjectId`, `selectedTaskId`, and `selectedTask`.
- `ProjectSwitcherPanel.svelte` selects the project.
- `TaskListPanel.svelte` loads server task records, filters them by selected
  project, and binds the selected task.
- `TaskDetailPanel.svelte` displays the selected task record and currently
  exposes task transition commands.
- `ProductWorkflowProofPanel.svelte` shows project-level workflow context and
  project-level next-step summary.
- `TaskWorkflowDrilldownProofPanel.svelte` queries the server-owned selected
  task drilldown and displays task, readiness, timeline, runtime, review, SCM,
  gaps, next, and no-effect flags.

The selected-task work-loop proof must use the drilldown and product summary as
read-only sources. It must not treat `TaskDetailPanel` transition controls as
guidance, and it must not add new command controls as part of this lane.

## Source Map

Selected identity:

- selected project id from the client state
- selected task id from the task list selection
- task ownership verified by the task workflow drilldown query

Task context sources:

- task records from server state
- task readiness projection
- product workflow summary task lanes and next source
- selected task drilldown task summary

Evidence sources:

- task timeline refs
- task-agent work-progress source records
- runtime receipt refs admitted through task-scoped work items
- command evidence refs admitted through runtime receipt edges
- live-evidence task completion refs
- review decision refs and work-item review status refs
- SCM capture admission, preparation, dry-run, review, and change-request prep
  refs that carry the selected task id

The lane may count and display refs. It must not expose payload bodies,
transcripts, terminal streams, raw stdout/stderr, credential material, or raw
provider payloads.

## Guidance Boundary

Guidance should answer what is safe to inspect or prepare next. It is not a
command admission surface.

Initial guidance belongs in the existing task workflow drilldown read model,
not a separate query. Reason: the drilldown already owns selected task
identity, source filtering, gaps, next source, and no-effect flags. A separate
query would duplicate the same source map before there is a second caller with
different needs.

Minimum guidance fields for the next batch:

- guidance source: task, readiness, runtime, review, SCM handoff, blocked, or
  no-op
- safe action label: inspect, plan, review, prepare handoff, wait, or blocked
- reason
- evidence refs
- missing evidence areas
- blocked reason when no safe action exists
- no-effect flags retained as false

Guidance may recommend operator inspection or preparation. It must not create,
start, delegate, review, accept, reject, complete, publish, push, merge, apply,
or schedule anything.

## Work-Loop Decision Order

The first selected-task guidance order is:

1. If the selected task is missing or belongs to another project, block on task
   identity repair.
2. If readiness says human planning is needed, guide toward planning
   inspection.
3. If readiness says agent delegation is possible and no work item exists,
   guide toward task delegation readiness, without scheduling an agent.
4. If work is running, waiting, failed, cancelled, or recovery-required, guide
   toward runtime/progress inspection.
5. If runtime completion exists and review is missing, guide toward review
   readiness.
6. If review exists and SCM handoff is missing, guide toward SCM handoff
   readiness.
7. If SCM handoff exists, guide toward handoff inspection.
8. If the task is done or archived, guide toward no-op unless a known pathway
   names a follow-on task.

This order is a presentation policy for the read model. It does not authorize
state transitions.

## Stop Conditions

Stop and replan if the next change requires:

- task mutation or new task command admission
- provider execution, callback, interruption, recovery, or scheduling
- SCM or forge mutation, including commit, branch creation, worktree creation,
  push, PR/MR creation, merge, snapshot, or publication
- accepted-memory active apply
- planning import active apply
- raw payload or credential exposure
- final UI layout/design commitments
- hidden inferred next-task selection without a pathway source

## Next Batch Input

Card `017` should add only a read-only guidance extension to the existing task
workflow drilldown read model unless implementation proves that this would
create inappropriate coupling.

Card `018` should then consume that guidance in the disposable desktop proof.
It should improve selected-task coherence without redesigning the shell.

Card `019` should focus only on review and SCM handoff gap presentation. It
should not reopen SCM execution.
