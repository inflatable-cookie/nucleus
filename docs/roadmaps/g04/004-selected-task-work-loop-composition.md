# 004 Selected Task Work Loop Composition

Status: active
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

- [ ] Define the selected-task work-loop boundary and stop conditions.
- [ ] Compose the task workflow proof into a clearer client-facing path.
- [ ] Surface review and SCM handoff gaps as next-action evidence, not fake
  readiness.
- [ ] Keep provider execution, SCM mutation, active memory apply, planning
  active apply, and final UI design out of scope.
- [ ] Choose the next product lane from evidence, not subsystem completion.

## Execution Plan

- [ ] Batch 1: selected-task work-loop boundary and source map.
- [ ] Batch 2: server/client read-model shape for work-loop action guidance.
- [ ] Batch 3: disposable desktop composition over existing proof panels.
- [ ] Batch 4: review and SCM handoff gap presentation.
- [ ] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- `batch-cards/016-selected-task-work-loop-boundary.md`

Planned cards:

- `batch-cards/017-selected-task-work-loop-guidance-read-model.md`
- `batch-cards/018-selected-task-work-loop-desktop-composition.md`
- `batch-cards/019-review-scm-handoff-gap-presentation.md`
- `batch-cards/020-selected-task-work-loop-validation-next-lane.md`

Completed cards:

- None.

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
