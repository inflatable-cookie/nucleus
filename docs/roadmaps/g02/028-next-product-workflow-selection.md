# 028 Next Product Workflow Selection

Status: paused
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
- [ ] Pick one next runway.
- [ ] Compile follow-on roadmap/cards only after the choice is explicit.

## Execution Plan

- [x] Options review batch: summarize viable workflow proofs.
- [x] Task-backed agent batch: assess readiness and blockers.
- [x] SCM management sync batch: assess readiness and blockers.
- [x] Native steward batch: assess readiness and blockers.
- [x] Selection batch: set the next ready runway or pause for operator choice.

## Batch Cards

Ready cards:

- none; paused for operator workflow selection

Completed cards:

- `batch-cards/119-g02-product-workflow-options-review.md`
- `batch-cards/120-task-backed-agent-workflow-readiness-gate.md`
- `batch-cards/121-scm-management-sync-workflow-readiness-gate.md`
- `batch-cards/122-native-steward-workflow-readiness-gate.md`
- `batch-cards/123-next-runway-selection-and-closeout.md`

## Acceptance Criteria

- [ ] The next workflow is chosen with evidence.
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

Do not open another implementation lane until Tom chooses the next workflow.

Engineering default, if Tom wants a recommendation: task-backed agent work unit.
It proves the core Nucleus promise most directly, but it also forces the first
runtime-target decision. Repo-backed management sync is the lower-risk
alternative if the next goal is multi-user project-management state before
provider execution. Native steward should follow once either task-backed work
or management sync has a real loop for the steward to manage.

## Pause Point

Operator decision required:

- choose task-backed agent work unit
- choose repo-backed management sync
- choose native steward workflow
- choose a different workflow and create the next runway from that

## Gate

Stop for operator intent if the workflow choice is product-directional rather
than engineering-obvious.
