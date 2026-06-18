# 028 Next Product Workflow Selection

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Choose the next product workflow after the diagnostics query runway.

The current G02 work has built command, runtime, projection, steward, SCM, and
diagnostics surfaces. The next implementation lane should prove one real
workflow instead of widening every subsystem at once.

## Governing Refs

- `docs/roadmaps/long-term-plan.md`
- `docs/roadmaps/reassessment-decision-queue.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/018-orchestration-contract.md`

## Goals

- [x] Review current implementation state after diagnostics are queryable.
- [x] Compare task-backed agent work, SCM management sync, and native steward
  workflow proofs.
- [x] Pick one next runway.
- [x] Compile follow-on roadmap/cards only after the choice is explicit.

## Execution Plan

- [x] Options review batch: summarize viable workflow proofs.
- [x] Task-backed agent batch: assess readiness and blockers.
- [x] SCM management sync batch: assess readiness and blockers.
- [x] Native steward batch: assess readiness and blockers.
- [x] Selection batch: set the next ready runway or pause for operator choice.

## Batch Cards

Completed cards:

- `batch-cards/119-g02-product-workflow-options-review.md`
- `batch-cards/120-task-backed-agent-workflow-readiness-gate.md`
- `batch-cards/121-scm-management-sync-workflow-readiness-gate.md`
- `batch-cards/122-native-steward-workflow-readiness-gate.md`
- `batch-cards/123-next-runway-selection-and-closeout.md`

## Acceptance Criteria

- [x] The next workflow is chosen with evidence.
- [x] G02 does not split into parallel speculative lanes.
- [x] Roadmap pointer is explicit at closeout.

## Options Review

### Task-Backed Agent Work Unit

Strengths:

- best fit for the product thesis: tasks become units of agentic work
- exercises orchestration, task timeline, runtime receipts, checkpoint refs,
  provider runtime supervision, and client diagnostics together
- matches the earlier decision-queue default

Blockers:

- first runtime target is still a product choice
- Codex live supervision is the most advanced bridged lane, but the app-owned
  steward lane is strategically important too
- provider execution still needs stricter recovery/cancellation/event identity
  gates before it should run unattended

### Repo-Backed Management Sync

Strengths:

- proves committable project/task state without needing model execution
- directly addresses multi-user workflow and Git/non-Git SCM concerns
- current management projection codecs, import staging, conflict reports, and
  sync records are already shaped

Blockers:

- SCM adapters are still metadata/proof surfaces
- first real Git mutation path would need host command authority, sandbox
  posture, and a no-surprise working-copy policy
- Convergence/non-Git terminology needs to remain first-class, which slows any
  Git-only shortcut

### Native Steward Workflow

Strengths:

- demonstrates Nucleus as more than a bridged-harness shell
- good fit for Effigy, task hygiene, sync assistance, and lightweight local
  models
- lower user-facing blast radius if scoped to proposals and read-only
  inspections

Blockers:

- local/model backend strategy is unresolved
- steward persistence and source records are still mostly read-model/proposal
  vocabulary
- autonomous action policy needs sharper approval and evidence contracts before
  it should do more than propose

## Recommendation

Selected runway: task-backed agent work unit.

First bridged runtime target: Codex.

Reason: task-backed work proves the core Nucleus promise most directly, and
Codex runtime supervision already has the strongest existing runway.
Repo-backed management sync is the lower-risk follow-on if the next goal is
multi-user project-management state. Native steward should follow once either
task-backed work or management sync has a real loop for the steward to manage.

## Pause Point

Next runway compiled:

- `029-health-and-module-boundary-reset.md`
- `030-task-backed-agent-workflow-contract-reset.md`
- `031-task-agent-work-unit-source-model.md`
- `032-codex-task-runtime-admission-bridge.md`
- `033-codex-task-event-ingestion-and-receipts.md`
- `034-task-work-checkpoint-and-review-loop.md`
- `035-desktop-task-agent-progress-proof.md`
- `036-task-backed-workflow-validation-and-next-lane.md`

## Gate

Stop for operator intent if the workflow choice is product-directional rather
than engineering-obvious.
