# 043 Steward SCM Sync Automation Gate

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Gate steward-assisted SCM sync automation behind explicit authority,
evidence, and reviewable decisions.

This lane does not make the steward autonomous over SCM mutation. It defines
what the steward may recommend, prepare, or request after management capture and
change-request evidence exists.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/018-steward-native-harness-and-effigy-tools.md`
- `docs/roadmaps/g02/039-scm-management-capture-and-share-foundation.md`
- `docs/roadmaps/g02/042-change-request-preparation-boundary.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [ ] Define steward authority for SCM sync assistance.
- [ ] Add steward sync decision records.
- [ ] Prove capture/apply loop fixtures for steward recommendations.
- [ ] Expose steward SCM sync diagnostics without action authority leakage.
- [ ] Keep autonomous provider mutation gated.

## Execution Plan

- [ ] Authority batch: define what the steward may decide, propose, or request.
- [ ] Decision batch: add steward sync decision records.
- [ ] Fixture batch: prove apply/capture/review loops under steward guidance.
- [ ] Diagnostics batch: expose steward sync state to clients.
- [ ] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/196-steward-sync-authority-contract.md`
- `batch-cards/197-steward-sync-decision-records.md`
- `batch-cards/198-steward-capture-apply-loop-fixtures.md`
- `batch-cards/199-steward-sync-diagnostics-read-model.md`
- `batch-cards/200-steward-sync-validation-and-next-lane.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Steward sync decisions are evidence-linked and reviewable.
- [ ] Steward recommendations do not bypass SCM or projection gates.
- [ ] Diagnostics distinguish recommendation, preparation, and execution.
- [ ] The next lane is selected from the long-term plan.

## Gate

Do not allow the steward to perform provider SCM mutation automatically until a
later explicit automation policy is approved.
