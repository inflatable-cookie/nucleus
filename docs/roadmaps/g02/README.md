# g02 Orchestration And Engine Core

Status: active
Owner: Tom
Updated: 2026-06-18

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
- `010-client-protocol-and-host-transport-runway.md` - completed
- `011-codex-app-server-runtime-runway.md` - completed
- `012-health-and-authority-surface-reset.md` - completed
- `013-host-authority-map-and-client-protocol-records.md` - completed
- `014-codex-live-runtime-supervision.md` - completed
- `015-task-backed-agent-work-unit-proof.md` - completed
- `016-management-projection-file-io-and-sync.md` - completed
- `017-scm-working-copy-and-change-request-workflows.md` - completed
- `018-steward-native-harness-and-effigy-tools.md` - completed
- `019-native-steward-command-boundary.md` - completed
- `020-effigy-command-backed-inspection.md` - completed
- `021-management-projection-sync-runtime.md` - completed
- `022-scm-working-session-runtime.md` - completed
- `023-client-read-model-and-diagnostics-runway.md` - completed
- `024-diagnostics-control-api-query-surface.md` - completed
- `025-diagnostics-control-dto-serialization.md` - completed
- `026-desktop-diagnostics-proof-surface.md` - completed
- `027-diagnostics-read-model-source-integration.md` - completed
- `028-next-product-workflow-selection.md` - completed
- `029-health-and-module-boundary-reset.md` - completed
- `030-task-backed-agent-workflow-contract-reset.md` - completed
- `031-task-agent-work-unit-source-model.md` - completed
- `032-codex-task-runtime-admission-bridge.md` - completed
- `033-codex-task-event-ingestion-and-receipts.md` - completed
- `034-task-work-checkpoint-and-review-loop.md` - completed
- `035-desktop-task-agent-progress-proof.md` - completed
- `036-task-backed-workflow-validation-and-next-lane.md` - completed
- `037-repo-backed-management-sync-hardening.md` - active

## Batch Cards

Ready cards:

- `batch-cards/164-management-projection-authority-policy.md`

Planned cards:

- `batch-cards/165-project-task-projection-export-hardening.md`
- `batch-cards/166-projection-import-conflict-fixtures.md`
- `batch-cards/167-management-sync-assistance-routing-proof.md`
- `batch-cards/168-management-sync-hardening-validation.md`

Completed cards:

- `batch-cards/001-event-store-record-contract-and-codec.md`
- `batch-cards/002-event-store-repository-boundary.md`
- `batch-cards/003-command-projection-replay-integrity.md`
- `batch-cards/004-event-store-hardening-validation.md`
- `batch-cards/005-engine-task-command-service.md`
- `batch-cards/006-task-command-admission-and-mutation-tests.md`
- `batch-cards/007-request-handler-task-command-delegation.md`
- `batch-cards/008-engine-task-command-validation.md`
- `batch-cards/009-task-timeline-record-shape.md`
- `batch-cards/010-task-command-event-to-timeline-projection.md`
- `batch-cards/011-task-timeline-query-boundary.md`
- `batch-cards/012-task-timeline-validation.md`
- `batch-cards/013-runtime-receipt-record-shape.md`
- `batch-cards/014-read-only-command-receipt-reactor.md`
- `batch-cards/015-runtime-receipt-projection-query.md`
- `batch-cards/016-runtime-receipt-validation.md`
- `batch-cards/017-checkpoint-record-shape.md`
- `batch-cards/018-diff-summary-record-shape.md`
- `batch-cards/019-checkpoint-diff-query-boundary.md`
- `batch-cards/020-checkpoint-diff-validation.md`
- `batch-cards/021-management-projection-schema-envelope.md`
- `batch-cards/022-minimal-project-task-projection-export.md`
- `batch-cards/023-management-projection-import-validation.md`
- `batch-cards/024-management-projection-conflict-reporting.md`
- `batch-cards/025-convergence-shape-and-vocabulary-risk-pass.md`
- `batch-cards/026-scm-forge-capability-neutralization.md`
- `batch-cards/027-driver-registry-and-fixture-surfaces.md`
- `batch-cards/028-workflow-gate-and-follow-on-runway.md`
- `batch-cards/029-harness-evidence-refresh.md`
- `batch-cards/030-harness-runtime-risk-comparison.md`
- `batch-cards/031-first-harness-target-decision.md`
- `batch-cards/032-harness-implementation-runway.md`
- `batch-cards/033-codex-app-server-schema-and-probe-evidence.md`
- `batch-cards/034-codex-adapter-registry-descriptor.md`
- `batch-cards/035-codex-session-lifecycle-identity.md`
- `batch-cards/036-codex-event-ingestion-fixtures.md`
- `batch-cards/037-error-god-file-module-splits.md`
- `batch-cards/038-server-boundary-authority-split.md`
- `batch-cards/039-g02-roadmap-suite-normalization.md`
- `batch-cards/040-health-reset-validation.md`
- `batch-cards/041-client-protocol-envelope-profile.md`
- `batch-cards/042-host-capability-advertisement-records.md`
- `batch-cards/043-client-auth-posture-records.md`
- `batch-cards/044-local-transport-selection-runway.md`
- `batch-cards/045-project-authority-map-record-shape.md`
- `batch-cards/046-host-authority-read-model-query.md`
- `batch-cards/047-protocol-authority-map-dto.md`
- `batch-cards/048-host-authority-map-validation.md`
- `batch-cards/049-codex-process-supervision-boundary.md`
- `batch-cards/050-codex-handshake-preflight.md`
- `batch-cards/051-codex-live-event-ingestion.md`
- `batch-cards/052-codex-wait-state-routing.md`
- `batch-cards/053-codex-recovery-and-runtime-validation.md`
- `batch-cards/054-task-agent-work-item-record-shape.md`
- `batch-cards/055-task-delegation-command-admission.md`
- `batch-cards/056-work-item-runtime-linkage-projection.md`
- `batch-cards/057-work-item-review-acceptance-boundary.md`
- `batch-cards/058-management-projection-file-format-codec.md`
- `batch-cards/059-management-projection-export-file-io.md`
- `batch-cards/060-management-projection-import-staging.md`
- `batch-cards/061-management-projection-sync-conflict-surface.md`
- `batch-cards/062-git-driver-status-and-ref-inspection.md`
- `batch-cards/063-working-copy-session-modes.md`
- `batch-cards/064-scm-checkpoint-diff-work-item-linkage.md`
- `batch-cards/065-change-request-prep-records.md`
- `batch-cards/066-steward-persona-authority-records.md`
- `batch-cards/067-native-tool-action-and-receipt-linkage.md`
- `batch-cards/068-effigy-selector-inventory-records.md`
- `batch-cards/069-effigy-health-and-validation-plan-records.md`
- `batch-cards/070-task-hygiene-proposal-records.md`
- `batch-cards/071-steward-sync-assistance-records.md`
- `batch-cards/072-native-model-backend-posture-records.md`
- `batch-cards/073-steward-lane-validation-and-next-runway.md`
- `batch-cards/074-native-steward-command-records.md`
- `batch-cards/075-native-steward-command-admission.md`
- `batch-cards/076-native-steward-command-receipt-linkage.md`
- `batch-cards/077-server-steward-command-boundary.md`
- `batch-cards/078-native-steward-command-validation.md`
- `batch-cards/079-effigy-selector-refresh-command.md`
- `batch-cards/080-effigy-doctor-summary-command.md`
- `batch-cards/081-effigy-test-plan-summary-command.md`
- `batch-cards/082-effigy-repair-hint-synthesis.md`
- `batch-cards/083-effigy-command-inspection-validation.md`
- `batch-cards/084-management-sync-plan-records.md`
- `batch-cards/085-projection-import-repair-proposals.md`
- `batch-cards/086-projection-conflict-assistance-routing.md`
- `batch-cards/087-management-capture-prep-records.md`
- `batch-cards/088-management-sync-runtime-validation.md`
- `batch-cards/089-scm-session-command-records.md`
- `batch-cards/090-git-session-admission-records.md`
- `batch-cards/091-non-git-session-vocabulary-validation.md`
- `batch-cards/092-scm-session-work-item-linkage.md`
- `batch-cards/093-scm-session-runtime-validation.md`
- `batch-cards/094-steward-diagnostics-read-model.md`
- `batch-cards/095-effigy-diagnostics-read-model.md`
- `batch-cards/096-sync-diagnostics-read-model.md`
- `batch-cards/097-scm-session-diagnostics-read-model.md`
- `batch-cards/098-client-diagnostics-dto-validation.md`
- `batch-cards/099-control-api-diagnostics-query-kinds.md`
- `batch-cards/100-server-query-result-diagnostics-variants.md`
- `batch-cards/101-request-handler-diagnostics-query-routing.md`
- `batch-cards/102-diagnostics-query-fixture-tests.md`
- `batch-cards/103-diagnostics-query-validation.md`
- `batch-cards/104-diagnostics-control-dto-record-shapes.md`
- `batch-cards/105-response-envelope-diagnostics-serialization.md`
- `batch-cards/106-tauri-ipc-diagnostics-boundary.md`
- `batch-cards/107-diagnostics-dto-authority-guard-tests.md`
- `batch-cards/108-diagnostics-dto-validation.md`
- `batch-cards/109-desktop-diagnostics-control-helper.md`
- `batch-cards/110-steward-effigy-diagnostics-panel.md`
- `batch-cards/111-sync-scm-diagnostics-panel.md`
- `batch-cards/112-desktop-diagnostics-loading-error-states.md`
- `batch-cards/113-desktop-diagnostics-proof-validation.md`
- `batch-cards/114-steward-diagnostics-source-records.md`
- `batch-cards/115-effigy-diagnostics-source-records.md`
- `batch-cards/116-sync-diagnostics-source-records.md`
- `batch-cards/117-scm-diagnostics-source-records.md`
- `batch-cards/118-diagnostics-source-integration-validation.md`
- `batch-cards/119-g02-product-workflow-options-review.md`
- `batch-cards/120-task-backed-agent-workflow-readiness-gate.md`
- `batch-cards/121-scm-management-sync-workflow-readiness-gate.md`
- `batch-cards/122-native-steward-workflow-readiness-gate.md`
- `batch-cards/123-next-runway-selection-and-closeout.md`
- `batch-cards/124-doctor-god-file-triage.md`
- `batch-cards/125-god-file-module-splits.md`
- `batch-cards/126-server-dto-module-pressure-review.md`
- `batch-cards/127-desktop-proof-surface-module-pressure-review.md`
- `batch-cards/128-health-reset-validation.md`
- `batch-cards/129-task-backed-workflow-lifecycle-contract.md`
- `batch-cards/130-task-work-unit-state-gap-review.md`
- `batch-cards/131-codex-task-runtime-binding-contract.md`
- `batch-cards/132-task-work-review-acceptance-contract.md`
- `batch-cards/133-task-backed-contract-validation.md`
- `batch-cards/134-task-work-unit-source-records.md`
- `batch-cards/135-task-delegation-work-unit-admission.md`
- `batch-cards/136-task-work-unit-state-projection.md`
- `batch-cards/137-task-work-unit-diagnostics-read-model.md`
- `batch-cards/138-task-work-unit-source-validation.md`
- `batch-cards/139-codex-task-runtime-request-records.md`
- `batch-cards/140-task-runtime-scheduler-admission.md`
- `batch-cards/141-codex-wait-state-task-linkage.md`
- `batch-cards/142-codex-task-runtime-recovery-gates.md`
- `batch-cards/143-codex-task-runtime-admission-validation.md`
- `batch-cards/144-codex-task-progress-event-mapping.md`
- `batch-cards/145-codex-task-command-receipt-linkage.md`
- `batch-cards/146-codex-task-permission-wait-states.md`
- `batch-cards/147-codex-task-error-retry-classification.md`
- `batch-cards/148-codex-task-event-ingestion-validation.md`
- `batch-cards/149-task-work-checkpoint-linkage.md`
- `batch-cards/150-task-work-diff-summary-linkage.md`
- `batch-cards/151-task-work-review-command-shapes.md`
- `batch-cards/152-task-work-review-timeline-projection.md`
- `batch-cards/153-task-work-review-validation.md`
- `batch-cards/154-task-work-progress-control-dtos.md`
- `batch-cards/155-desktop-task-work-progress-panel.md`
- `batch-cards/156-desktop-task-work-wait-state-display.md`
- `batch-cards/157-desktop-task-work-review-display.md`
- `batch-cards/158-desktop-task-agent-progress-validation.md`
- `batch-cards/159-task-backed-workflow-fixture-validation.md`
- `batch-cards/160-task-backed-findings-promotion.md`
- `batch-cards/161-post-runtime-health-gate.md`
- `batch-cards/162-next-workflow-lane-selection.md`
- `batch-cards/163-g02-task-backed-runway-closeout.md`

## Planned Runway Sequence

The next G02 suite is:

1. health and authority surface reset - completed
2. client protocol and host transport runway - completed
3. host authority map records and client read models - completed
4. live Codex runtime supervision - completed
5. task-backed agent work unit proof - completed
6. management projection file IO and sync - completed
7. SCM working-copy/change-request workflows - completed
8. steward/native harness and Effigy tools - completed
9. native steward command boundary - completed
10. Effigy command-backed inspection - completed
11. management projection sync runtime - completed
12. SCM working session runtime - completed
13. client read model and diagnostics runway - completed
14. diagnostics control API query surface - completed
15. diagnostics control DTO serialization - completed
16. desktop diagnostics proof surface - completed
17. diagnostics read-model source integration - completed
18. next product workflow selection - completed
19. health and module boundary reset - completed
20. task-backed agent workflow contract reset - completed
21. task-agent work-unit source model - completed
22. Codex task runtime admission bridge - completed
23. Codex task event ingestion and receipts - completed
24. task work checkpoint and review loop - completed
25. desktop task-agent progress proof - completed
26. task-backed workflow validation and next lane - completed
27. repo-backed management sync hardening - active

This keeps code health and task authority clarity ahead of deeper provider
runtime work.

## Planning Rules

- `029` is the active planning milestone.
- `014` proved the first compile-only live provider runtime supervision spine.
- `015` proved the first task-backed agent work unit.
- `016` built committable projection file IO.
- `017` completed SCM/change-request workflow records.
- `018` closed the record-only native steward runway.
- `019` completed native steward command admission, receipt linkage, and server
  command boundaries.
- `020` completed Effigy command-backed inspection.
- `021` completed management projection sync runtime records.
- `022` completed SCM working-session runtime records.
- `023` completed diagnostics read-model DTOs.
- `024` completed diagnostics control queries.
- `025` completed diagnostics control DTO serialization.
- `026` completed a disposable desktop diagnostics proof surface.
- `027` completed diagnostics source-status integration.
- `028` selected task-backed agent work unit with Codex as the first bridged
  runtime target.
- `029` repairs the red health gate before runtime work expands.
- `030` tightens task-backed workflow contracts.
- `031` adds task work-unit source records.
- `032` bridges task work units to Codex runtime admission without execution.
- `033` maps Codex observations into task progress and receipts.
- `034` adds checkpoint/review boundaries.
- `035` exposes task-agent progress in the disposable desktop proof shell.
- `036` validates the runway and chooses the next workflow.
- `037` hardens repo-backed management projection authority.
- Later milestones have full planned cards, but only the current card should
  be marked ready until predecessor validation passes.

Keep future cards broad enough to execute meaningful chunks. Do not create
one-card turns unless the card is risky or blocked.
