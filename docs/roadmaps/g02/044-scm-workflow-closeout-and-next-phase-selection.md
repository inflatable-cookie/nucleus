# 044 SCM Workflow Closeout And Next Phase Selection

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Close the SCM workflow runway, audit docs/code drift, and select the next phase
from the long-term plan.

This is a deliberate checkpoint before switching back to harness runtime,
native steward depth, remote transport, workspace panels, or another large
phase.

## Governing Refs

- `docs/roadmaps/long-term-plan.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/architecture-gap-index.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/roadmaps/g02/039-scm-management-capture-and-share-foundation.md`
- `docs/roadmaps/g02/040-git-management-capture-adapter-proof.md`
- `docs/roadmaps/g02/041-scm-working-session-execution-prep.md`
- `docs/roadmaps/g02/042-change-request-preparation-boundary.md`
- `docs/roadmaps/g02/043-steward-scm-sync-automation-gate.md`

## Goals

- [ ] Audit remaining Phase 3 SCM gaps.
- [ ] Compare docs promises to implemented code.
- [ ] Choose the next phase from the long-term plan.
- [ ] Rebaseline roadmap indexes and gap indexes.
- [ ] Decide whether G02 should continue or pause for a later generation
      rollover.

## Execution Plan

- [ ] Gap-review batch: identify remaining SCM and forge workflow gaps.
- [ ] Drift-audit batch: compare roadmap/contract claims to code.
- [ ] Decision batch: select the next phase and record why.
- [ ] Rebaseline batch: update long-term and gap indexes.
- [ ] Closeout batch: mark the runway state and prepare the next ready card.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/201-phase3-scm-gap-review.md`
- `batch-cards/202-docs-code-drift-audit.md`
- `batch-cards/203-next-phase-readiness-decision.md`
- `batch-cards/204-long-term-plan-rebaseline.md`
- `batch-cards/205-g02-scm-runway-closeout.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] SCM workflow gaps are current and visible.
- [ ] Docs do not overclaim implementation state.
- [ ] The next phase is selected from the long-term plan.
- [ ] Roadmap front doors point at one clear next task.

## Gate

Do not open a new implementation phase until this checkpoint resolves whether
the current SCM runway is complete enough to switch focus.
