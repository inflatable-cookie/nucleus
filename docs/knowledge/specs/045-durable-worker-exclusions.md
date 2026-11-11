# 045 — Durable task worker exclusions

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-05
Decision owner: planner
Governing refs: [Spec 030](030-routing-changes.md) (routing before dispatch),
[Spec 036](036-role-reassignment.md) (worker replacement after dispatch)

## Problem

A planner may decide in conversation that a worker must receive no more turns.
That decision is lost between coordinator runs, and the ordinary revision path
can resume the retained worker after a later coordinator recommends `move to=work`.

## Decision

- A versioned `queue.task` action `exclude_worker` records one exact `agentId`
  or one `profileId`, a required reason and its creation time on the task.
- The control applies only to a live, unmerged task, checks the current task
  version, and writes one task update and audit event. A relayed action includes
  the operator authorization note.
- The exclusion is visible in task detail and in every recovery coordinator
  prompt. Recovery prompts say Nucleus will not resume an excluded worker and
  will not ask the coordinator to pick a replacement profile.
- Before any revision run, Nucleus checks the retained worker's agent and profile
  against active exclusions. A match prevents the send. A changes-requested
  task with an excluded retained worker goes through the existing worker
  replacement path; profile exclusions are removed from candidate selection.
- Initial and replacement worker selection also honor profile exclusions. If
  no eligible profile remains, Nucleus waits visibly instead of assigning one.
- An agent-only exclusion excludes that agent identity. A profile exclusion
  excludes every agent using that profile for this task.

## Acceptance

| Scenario | Required result |
| --- | --- |
| Missing or ambiguous target, missing reason, or stale task version | Refused without changing task state |
| Current worker agent or profile is excluded | Exclusion is durably recorded and task detail shows it |
| Recovery coordinator receives the task | Prompt includes each exclusion and forbids another turn to it |
| Coordinator returns a changes-requested task to revision | Nucleus sends no turn to an excluded retained worker |
| Excluded retained worker has an open PR needing changes | Existing replacement path selects an unexcluded profile and preserves task/workspace/PR identity |
| Every eligible worker profile is excluded | No worker is assigned; Nucleus leaves a visible wait/attention reason |
| Exact agent is excluded | That identity receives no further revision; a different agent may use the same profile |
