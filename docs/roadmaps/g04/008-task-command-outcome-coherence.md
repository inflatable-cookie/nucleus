# 008 Task Command Outcome Coherence

Status: active
Owner: Tom
Updated: 2026-07-07

## Purpose

Make explicit task-only command mutation feel coherent in the product workflow.

The selected-task admission lane lets the desktop submit server-admitted task
commands. The next gap is after the command: the client must refresh task
records, timeline/workflow drilldown, command receipt, and next-step context
from server authority instead of relying on stale selected-task props or local
guessing.

## Governing Refs

- `docs/roadmaps/g04/007-selected-task-command-admission-controls.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Refresh selected task records after task-only command receipts.
- [ ] Refresh task workflow drilldown and action gates after command receipts.
- [ ] Surface command receipt and task timeline evidence together.
- [ ] Keep next-step context server-owned and refreshed after mutation.
- [ ] Keep provider, SCM/forge, delegation, review, memory, and planning apply
  controls out of this lane.

## Execution Plan

- [x] Batch 1: shell refresh boundary for task command outcomes.
- [ ] Batch 2: desktop task-command refresh loop.
- [ ] Batch 3: receipt and timeline presentation.
- [ ] Batch 4: guard validation and next lane selection.

## Batch Cards

Ready cards:

- `batch-cards/037-task-command-desktop-refresh-loop.md`

Planned cards:

- `batch-cards/038-task-command-receipt-timeline-presentation.md`
- `batch-cards/039-task-command-outcome-validation-next-lane.md`

Completed cards:

- `batch-cards/036-task-command-refresh-boundary.md`

## Boundary

This lane may:

- route a task-command success signal from the workflow proof panel to the
  shell task-list refresh path
- refresh selected task, task workflow drilldown, action readiness, operator
  gate, and command-admission context after task mutation
- display command receipt and timeline refs as proof evidence
- improve disposable proof labels and status states

This lane must not:

- add provider execution
- schedule delegation or agent work
- run SCM or forge mutation
- accept review evidence
- apply memory or planning imports
- create final UI design commitments
- let the desktop synthesize task state outside server command responses
