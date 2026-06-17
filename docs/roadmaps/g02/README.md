# g02 Orchestration And Engine Core

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Move Nucleus from bootstrap/proof surfaces into the core architecture that will
govern real runtime work.

`g02` starts from the 2026-06-17 reassessment. The generation is intentionally
orchestration-first: do not pick provider runtime, UI panel, remote transport,
or SCM implementation work until the central command/event/projection model
and engine boundary are settled.

## Milestones

- `001-orchestration-and-engine-boundary.md` - completed
- `002-event-store-persistence-hardening.md` - completed
- `003-engine-task-command-boundary.md` - completed
- `004-task-timeline-and-history-projection.md` - completed
- `005-runtime-receipts-and-effect-reactors.md` - completed
- `006-checkpoint-and-diff-foundation.md` - completed
- `007-management-projection-sync-foundation.md` - completed
- `008-scm-forge-driver-runway.md` - completed
- `009-harness-runtime-target-selection.md` - completed
- `010-client-protocol-and-host-transport-runway.md` - active
- `011-codex-app-server-runtime-runway.md` - completed
- `012-health-and-authority-surface-reset.md` - completed
- `013-host-authority-map-and-client-protocol-records.md` - planned after `010`
- `014-codex-live-runtime-supervision.md` - planned after `013`
- `015-task-backed-agent-work-unit-proof.md` - planned after `014`
- `016-management-projection-file-io-and-sync.md` - planned after `015`
- `017-scm-working-copy-and-change-request-workflows.md` - planned after `016`
- `018-steward-native-harness-and-effigy-tools.md` - planned after `017`

## Batch Cards

Completed cards:

- `batch-cards/001-event-store-record-contract-and-codec.md`
- `batch-cards/002-event-store-repository-boundary.md`
- `batch-cards/003-command-projection-replay-integrity.md`
- `batch-cards/004-event-store-hardening-validation.md`

Completed cards:

- `batch-cards/005-engine-task-command-service.md`
- `batch-cards/006-task-command-admission-and-mutation-tests.md`
- `batch-cards/007-request-handler-task-command-delegation.md`
- `batch-cards/008-engine-task-command-validation.md`

Completed cards:

- `batch-cards/009-task-timeline-record-shape.md`
- `batch-cards/010-task-command-event-to-timeline-projection.md`
- `batch-cards/011-task-timeline-query-boundary.md`
- `batch-cards/012-task-timeline-validation.md`

Completed cards:

- `batch-cards/013-runtime-receipt-record-shape.md`
- `batch-cards/014-read-only-command-receipt-reactor.md`
- `batch-cards/015-runtime-receipt-projection-query.md`
- `batch-cards/016-runtime-receipt-validation.md`

Completed cards:

- `batch-cards/017-checkpoint-record-shape.md`
- `batch-cards/018-diff-summary-record-shape.md`
- `batch-cards/019-checkpoint-diff-query-boundary.md`
- `batch-cards/020-checkpoint-diff-validation.md`

Completed cards:

- `batch-cards/021-management-projection-schema-envelope.md`
- `batch-cards/022-minimal-project-task-projection-export.md`
- `batch-cards/023-management-projection-import-validation.md`
- `batch-cards/024-management-projection-conflict-reporting.md`

Completed cards:

- `batch-cards/025-convergence-shape-and-vocabulary-risk-pass.md`
- `batch-cards/026-scm-forge-capability-neutralization.md`
- `batch-cards/027-driver-registry-and-fixture-surfaces.md`
- `batch-cards/028-workflow-gate-and-follow-on-runway.md`

Completed cards:

- `batch-cards/029-harness-evidence-refresh.md`
- `batch-cards/030-harness-runtime-risk-comparison.md`
- `batch-cards/031-first-harness-target-decision.md`
- `batch-cards/032-harness-implementation-runway.md`
- `batch-cards/033-codex-app-server-schema-and-probe-evidence.md`
- `batch-cards/034-codex-adapter-registry-descriptor.md`
- `batch-cards/035-codex-session-lifecycle-identity.md`
- `batch-cards/036-codex-event-ingestion-fixtures.md`

Completed cards:

- `batch-cards/037-error-god-file-module-splits.md`
- `batch-cards/038-server-boundary-authority-split.md`
- `batch-cards/039-g02-roadmap-suite-normalization.md`
- `batch-cards/040-health-reset-validation.md`

Ready cards:

- `batch-cards/042-host-capability-advertisement-records.md`

Planned cards:

- `batch-cards/043-client-auth-posture-records.md`
- `batch-cards/044-local-transport-selection-runway.md`

Completed cards:

- `batch-cards/041-client-protocol-envelope-profile.md`

## Planned Runway Sequence

The next G02 suite is:

1. health and authority surface reset - completed
2. client protocol and host transport runway - active
3. host authority map records and client read models
4. live Codex runtime supervision
5. task-backed agent work unit proof
6. management projection file IO and sync
7. SCM working-copy/change-request workflows
8. steward/native harness and Effigy tools

This keeps code health and authority-map clarity ahead of live provider and
remote transport work.

## Planning Rules

- `010` is the only active milestone.
- `010` defines protocol and transport runway
  shape, not live remote behavior.
- `013` turns the host authority map and protocol runway into concrete records.
- `014` is the first live provider runtime milestone.
- `015` proves the first task-backed agent work unit.
- `016`, `017`, and `018` then build committable projection file IO,
  SCM/change-request workflows, and steward/native harness tools.
- Planned milestones must not get batch cards until their predecessor gate is
  clear enough to execute.

Keep future cards broad enough to execute meaningful chunks. Do not create
one-card turns unless the card is risky or blocked.
