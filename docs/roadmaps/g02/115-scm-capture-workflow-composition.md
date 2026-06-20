# 115 SCM Capture Workflow Composition

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Compose completion-to-SCM capture, dry-run planning, Git read-only execution,
sanitized evidence, persistence, and diagnostics into one replayable workflow
projection.

This lane is still not a commit, push, branch, PR, merge, provider, callback,
interruption, recovery, or raw-output lane.

## Governing Refs

- `docs/roadmaps/g02/094-completion-to-scm-change-request-readiness.md`
- `docs/roadmaps/g02/103-scm-capture-driver-dry-run-planning.md`
- `docs/roadmaps/g02/111-git-dry-run-command-execution-persistence.md`
- `docs/roadmaps/g02/114-git-read-only-runner-evidence-composition.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define a workflow projection over completion, dry-run plan, Git runner,
  evidence, persistence, and diagnostics records.
- [x] Keep the workflow replay-only and deterministic.
- [x] Surface repair-required and blocked stages without hiding partial state.
- [x] Keep raw output and mutation authority blocked.
- [x] Prepare the next lane for change-request preparation or operator review.

## Execution Plan

- [x] Workflow projection record batch.
- [x] Workflow stage-state projection batch.
- [x] Workflow diagnostics batch.
- [x] Workflow authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/539-scm-capture-workflow-projection-records.md`
- `batch-cards/540-scm-capture-workflow-stage-state.md`
- `batch-cards/541-scm-capture-workflow-diagnostics.md`
- `batch-cards/542-scm-capture-workflow-authority.md`
- `batch-cards/543-scm-capture-workflow-closeout.md`

## Acceptance Criteria

- [x] Workflow projection composes existing records by stable refs.
- [x] Stage state reports ready, completed, blocked, repair-required, and
  missing states.
- [x] Diagnostics summarize the workflow without raw output.
- [x] Mutating Git, forge, provider, callback, interruption, and recovery
  authority remain blocked.
- [x] Validation passes or blockers are recorded.
