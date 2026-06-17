# 001 Orchestration And Engine Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Define and implement the central work spine for Nucleus.

This milestone turns the reassessment findings into a coherent architecture
runway before provider runtimes, SCM workflows, remote host transport, or more
UI panels are expanded.

## Governing Refs

- `docs/logs/2026-06-17-stocktake.md`
- `docs/roadmaps/reassessment-decision-queue.md`
- `docs/roadmaps/long-term-plan.md`
- `docs/architecture/architecture-gap-index.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/t3-code-comparison.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/architecture/engine-orchestration-boundary.md`

## Goals

- [x] Decide whether event-sourced orchestration is the core model.
- [x] Define command, event, projection, replay, and receipt boundaries.
- [x] Define timeline entities for project, task, session, thread, turn,
  message, activity, checkpoint, and runtime receipt.
- [x] Decide whether to add `nucleus-engine`, `nucleus-orchestration`, or both.
- [x] Decide what must move out of `nucleus-server`.
- [x] Split or summarize oversized authority surfaces so the next code lane has
  clear governing refs.
- [x] Clear the high `effigy doctor` god-file finding before treating the repo
  as healthy for the next implementation tranche.

## Execution Plan

- [x] Planning batch: promote the orchestration decision into contracts.
- [x] Architecture batch: split the engine/host/server ownership boundary.
- [x] Health batch: split the high command-policy storage codec god-file.
- [x] Implementation batch: scaffold the chosen engine/orchestration crate
  boundary.
- [x] Migration batch: route one existing project/task read path through the
  new boundary as proof.
- [x] Command admission batch: route one existing task command path through
  `nucleus-orchestration` admission before mutation.
- [x] Event append batch: append one orchestration command-admitted event and
  projection cursor for admitted task commands.
- [x] Projection rebuild batch: rebuild a command-admission projection from the
  event journal.

## Acceptance Criteria

- [x] The orchestration model is explicitly chosen.
- [x] Contract refs exist for orchestration, timeline, runtime receipts, and
  checkpoint ownership, or the milestone explains why one is intentionally
  deferred.
- [x] `nucleus-server` has a documented host/API role that does not conflict
  with the portable Rust engine.
- [x] The first implementation tranche has broad batch cards, not one-card
  micro-steps.
- [x] `effigy doctor` no longer fails on the high god-file finding, or the
  failure is explicitly accepted as a blocker before implementation continues.
- [x] `effigy qa:docs` and `effigy qa:northstar` pass.
- [x] One existing project/task read path routes through `nucleus-engine`.
- [x] One existing task command path routes through `nucleus-orchestration`
  admission before mutation.
- [x] One admitted task command path writes a replayable event-journal record
  before mutation.
- [x] One event-journal projection read path rebuilds from orchestration event
  records.

## Stop Conditions

- A proposed implementation lane depends on provider runtime, remote transport,
  SCM mutation, or UI panels before the engine boundary exists.
- The roadmap starts creating micro-cards again instead of grouped batches.

## Outcome

- Chose event-sourced orchestration as the central model for durable work that
  needs replay, projections, host handoff, provider runtime ingestion, task
  history, checkpoints, and multi-client reconciliation.
- Added `nucleus-orchestration` and `nucleus-engine` as separate Rust crates.
- Split the high command-policy storage codec file into smaller modules.
- Routed project, task, and workspace read queries through
  `nucleus-engine::EngineReadModelService`.
- Routed task command admission through `nucleus-orchestration` before existing
  mutation handling.
- Appended one replayable command-admitted event before admitted task command
  mutation.
- Rebuilt a command-admission projection from orchestration event-journal
  records.

## Closeout

This milestone is complete. Event-store persistence hardening is deliberately
split into `002-event-store-persistence-hardening.md` so this boundary proof
does not become an overloaded catch-all milestone.
