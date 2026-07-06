# 001 Product Workflow Rebaseline And Vertical Slice

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Recenter Nucleus on a usable product workflow after g03's long run of
effect-gated backend proof surfaces.

The vertical slice should show a project-oriented workflow over existing
server-owned records: project, tasks, planning context, accepted memory
summaries, agent/runtime evidence, review state, and SCM readiness. It should
not open new provider, SCM, memory-apply, panel-layout, or final UI lanes.

## Governing Refs

- `docs/vision/001-nucleus-product-vision.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/server-client-gap-matrix.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the product workflow slice and its explicit non-goals.
- [x] Compose a server-owned workflow summary/read model from existing records.
- [x] Expose the summary through read-only `nucleusd` and Effigy inspection.
- [x] Add a disposable desktop proof surface only if it consumes the server
  read model.
- [x] Keep clients non-authoritative.
- [x] Keep accepted-memory active apply, provider expansion, SCM/forge
  mutation, final UI design, panel-layout work, plugin runtime, automatic task
  mutation, and broad automation out of scope.

## Execution Plan

- [x] Batch 1: define workflow slice boundary, source records, user story,
  stop conditions, and deferred lanes.
- [x] Batch 2: implement a read-only product workflow summary/read model over
  existing project, task, planning, memory, runtime, review, and SCM readiness
  evidence.
- [x] Batch 3: expose the workflow summary through server query, control DTO,
  `nucleusd`, and Effigy.
- [x] Batch 4: add a disposable desktop proof surface if the read model is
  stable and useful.
- [x] Batch 5: validate the slice and choose whether g04 continues into
  task-backed agent loop hardening, SCM handoff UX, planning/research UX, or
  broader client workflow work.

## Batch Cards

Ready cards:

No ready cards. This roadmap is complete.

Planned cards:

No planned cards. This roadmap is complete.

Completed cards:

- `batch-cards/001-product-workflow-lane-boundary.md`
- `batch-cards/002-product-workflow-read-model.md`
- `batch-cards/003-product-workflow-cli-effigy-inspection.md`
- `batch-cards/004-disposable-product-workflow-proof.md`
- `batch-cards/005-product-workflow-validation-next-lane.md`

## User Workflow

The first g04 slice answers one question:

> What should I work on in this project, what context already exists, what
> agent/runtime evidence is available, and what review or SCM handoff is next?

The user path is:

1. Open or inspect a project.
2. See the active project identity and authority posture.
3. See task candidates grouped by workflow state.
4. See planning context and task seeds that explain why work exists.
5. See memory/research context as supporting summaries, not mutation targets.
6. See agent/runtime evidence and review state for active or recent work.
7. See SCM readiness or handoff status when work has evidence suitable for a
   change request.
8. See a next task or blocked reason derived from known roadmap, task, goal,
   planning, validation, or review evidence.

The slice is successful if the output is useful even before final UI exists.

## Source Record Inventory

Use existing records first.

Primary sources:

- project state records and project authority map query
- task records and task readiness candidates
- task timeline entries
- task work-item source, runtime, progress, and review evidence where already
  persisted
- planning sessions and planning task seeds
- task seed promotion diagnostics
- planning projection/export/import/readiness diagnostics
- memory proposal and accepted-memory read-only diagnostics
- research run briefs
- command evidence summaries
- provider/runtime evidence summaries where already sanitized
- SCM capture, review, change-request, and readiness records where already
  represented

Source gaps must be explicit. The read model may say a source is unavailable,
empty, or not yet implemented. It must not invent task status, review outcome,
SCM readiness, or next-task priority.

## Workflow Summary Shape

The first read model should be coarse and useful:

- `project`: project id, display name if available, status, authority summary
- `task_lanes`: grouped candidates such as ready, active, awaiting review,
  blocked, repair required, completed, archived
- `planning_context`: planning session counts, task seed counts, accepted
  planning refs, gaps
- `context`: memory proposal counts, accepted-memory counts, research brief
  counts, evidence refs
- `runtime`: active/recent work refs, command evidence counts, provider/runtime
  evidence refs, missing evidence gaps
- `review`: awaiting review, accepted, needs changes, blocked, abandoned, or
  unknown counts where available
- `scm_readiness`: capture/prep/change-request readiness refs and gaps
- `next`: next task/action source, next ref, rationale refs, or blocked reason
- `no_effects`: explicit false flags for mutation/provider/SCM/UI effects

The model should prefer counts, status labels, and stable refs over large
payloads. It should be readable from CLI output.

## Explicit Non-Goals

This slice does not:

- rank tasks with a new scoring algorithm
- mutate tasks, planning artifacts, accepted memory, research, SCM, or provider
  state
- schedule agents or start provider execution
- answer callbacks, cancellation, interruption, or recovery requests
- apply accepted-memory imports
- write projection files
- create branches, worktrees, commits, pushes, PRs, snapshots, or publications
- add final UI layout, panels, editor, plugin runtime, or design commitments
- store raw transcripts, raw command output, provider payloads, terminal
  streams, credentials, secrets, or private notes

## Deferred Lanes

Return-later lanes remain in `docs/roadmaps/deferred-lanes.md`.

The g04 slice may mention deferred work only as a gap or future action. It must
not reopen accepted-memory active apply, planning active apply, provider
live-read expansion, or Convergence backend execution.

## Boundary

This lane may:

- summarize existing project and task records
- summarize existing planning sessions, task seeds, accepted planning
  artifacts, memory proposals, accepted memory records, runtime receipts,
  review evidence, and SCM readiness records
- expose a read-only workflow view to CLI/Effigy and a disposable desktop
  surface
- recommend next tasks only from known roadmap/task/goal/workflow evidence

This lane must not:

- mutate tasks automatically
- execute providers, SCM, forge, callbacks, interruption, or recovery
- apply accepted-memory imports
- write projection files
- create final panel, editor, plugin, or design-system commitments
- treat client UI as the state authority

## Stop Conditions

- The work requires creating a new mutable subsystem instead of composing
  existing records.
- The work requires provider writes, SCM/forge writes, accepted-memory active
  apply, task mutation, agent scheduling, final UI, plugin runtime, or panel
  layout behavior.
- The read model cannot explain a user-visible workflow without inventing
  state that does not exist.

## Acceptance Criteria

- [x] The workflow slice is explicit, bounded, and product-shaped.
- [x] The read model remains server-owned and read-only.
- [x] CLI/Effigy output can explain the workflow state without raw payloads.
- [x] Any desktop proof consumes the server surface and remains disposable.
- [x] Deferred lanes remain discoverable outside the active next-task pointer.

## Result

The first g04 slice proves a server-owned product workflow surface across
project identity, task candidates, placeholder planning/context/runtime/review
bands, SCM readiness gaps, and next-action reporting.

Validation passed for focused server, CLI, Effigy, and disposable desktop proof
checks. The remaining product gap is source composition: the workflow summary
still needs to consume existing planning, memory, research, runtime, review,
SCM, and next-step records instead of reporting broad gaps when those records
already exist.
