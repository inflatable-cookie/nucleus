# 110 Task Project Workflow Depth

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Deepen the task/project workflow after server/client query parity.

The lane should move Nucleus closer to the core product loop: durable projects,
structured planning, task-backed work, task timelines, and next-task selection.
It must not drift back into provider execution, visible UI design, or broad
SCM/forge effects.

## Governing Refs

- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/server-client-query-surface-inventory.md`
- `docs/architecture/server-client-gap-matrix.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`

## Generation Runway Link

This lane advances the g03 server-owned read-model and control-boundary work by
returning from provider readiness into the product workflow spine.

Immediate focus:

- task/project implementation audit
- next-task and readiness read-model shape
- planning-artifact linkage into tasks
- task timeline and work-item evidence gaps
- narrow implementation only after the audit proves contracts are sufficient

## Goals

- [x] Audit task/project workflow implementation against promoted contracts.
- [x] Identify missing task, project, planning, and timeline read models.
- [x] Define a bounded next-task/readiness surface from existing runway and
  task evidence, not from arbitrary heuristics.
- [x] Preserve task mutation authority; add read-only surfaces first unless a
  command path is already governed.
- [x] Keep UI work deferred unless a server/client proof requires a disposable
  read-only adapter.

## Execution Plan

- [x] Batch 1: audit current task, project, timeline, planning, and control
  code against governing contracts.
- [x] Batch 2: write a task/project workflow gap matrix that separates
  implemented, planned, blocked, and deferred surfaces.
- [x] Batch 3: select the first bounded implementation slice. Prefer a
  read-only next-task/readiness projection if contracts already support it.
- [x] Batch 4: implement the selected slice through Rust modules, tests,
  control DTOs, CLI/Effigy inspection, and docs.
- [x] Batch 5: validate, close the lane, and choose the next product workflow
  milestone.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/450-task-project-workflow-closeout.md`
- `batch-cards/449-task-project-next-lane-checkpoint.md`
- `batch-cards/448-task-project-workflow-validation.md`
- `batch-cards/447-task-project-control-cli-effigy.md`
- `batch-cards/446-task-project-read-model-implementation.md`
- `batch-cards/445-next-task-readiness-surface-selection.md`
- `batch-cards/443-task-project-workflow-implementation-audit.md`
- `batch-cards/444-task-project-workflow-gap-matrix.md`

## Acceptance Criteria

- [x] Audit evidence maps code to contract refs without inventing missing
  behavior.
- [x] Gap matrix identifies the next implementation slice and explicit
  non-goals.
- [x] Any implemented surface is server-owned, read-only unless command-gated,
  deterministic, and covered by focused tests.
- [x] CLI/Effigy exposure exists for any new inspection surface.
- [x] No task mutation, provider execution, provider writes, credential
  material storage, raw provider payload retention, or UI-triggered provider
  reads are added.

## Stop Conditions

- Required task/project behavior is not represented in promoted contracts.
- Next-task selection requires scoring policy that is not yet contracted.
- Implementation would require final desktop UI design.
- Implementation would require provider execution, SCM/forge mutation, or
  task mutation without a command contract.

## Closeout

The lane added a deterministic, read-only task readiness projection and exposed
it through server query, serialized control DTOs, `nucleusd`, and Effigy.

The selected next product lane is structured planning artifact to task seed
promotion. It must preserve task seeds as reviewable planning output and must
not silently create active tasks.
