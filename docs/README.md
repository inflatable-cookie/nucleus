# Nucleus Docs

This is the Northstar authority surface for nucleus.

## Current Posture

Strict from start.

The repo uses:

- `vision/README.md` for long-horizon intent
- `architecture/README.md` for system shape and inventories
- `contracts/README.md` for durable rules and interfaces
- `specs/README.md` for provisional planning
- `roadmaps/README.md` for sequenced work
- `logs/README.md` for decisions and evidence
- `research/README.md` for external evidence before promotion

## Current Lane

`g02` orchestration and engine core.

Current planning artifacts:

- `logs/2026-06-17-stocktake.md`
- `logs/2026-06-17-g02-rollover.md`
- `logs/2026-06-18-stocktake.md`
- `logs/2026-06-19-scm-runway-closeout.md`
- `logs/2026-06-19-codex-live-smoke-evidence.md`
- `roadmaps/long-term-plan.md`
- `roadmaps/reassessment-decision-queue.md`
- `roadmaps/g02/001-orchestration-and-engine-boundary.md`
- `roadmaps/g02/002-event-store-persistence-hardening.md`
- `roadmaps/g02/003-engine-task-command-boundary.md`
- `roadmaps/g02/004-task-timeline-and-history-projection.md`
- `roadmaps/g02/005-runtime-receipts-and-effect-reactors.md`
- `roadmaps/g02/006-checkpoint-and-diff-foundation.md`
- `roadmaps/g02/007-management-projection-sync-foundation.md`
- `roadmaps/g02/008-scm-forge-driver-runway.md`
- `roadmaps/g02/009-harness-runtime-target-selection.md`
- `roadmaps/g02/010-client-protocol-and-host-transport-runway.md`
- `roadmaps/g02/011-codex-app-server-runtime-runway.md`
- `roadmaps/g02/012-health-and-authority-surface-reset.md`
- `roadmaps/g02/013-host-authority-map-and-client-protocol-records.md`
- `roadmaps/g02/014-codex-live-runtime-supervision.md`
- `roadmaps/g02/015-task-backed-agent-work-unit-proof.md`
- `roadmaps/g02/016-management-projection-file-io-and-sync.md`
- `roadmaps/g02/017-scm-working-copy-and-change-request-workflows.md`
- `roadmaps/g02/018-steward-native-harness-and-effigy-tools.md`
- `roadmaps/g02/019-native-steward-command-boundary.md`
- `roadmaps/g02/020-effigy-command-backed-inspection.md`
- `roadmaps/g02/021-management-projection-sync-runtime.md`
- `roadmaps/g02/022-scm-working-session-runtime.md`
- `roadmaps/g02/023-client-read-model-and-diagnostics-runway.md`
- `roadmaps/g02/024-diagnostics-control-api-query-surface.md`
- `roadmaps/g02/025-diagnostics-control-dto-serialization.md`
- `roadmaps/g02/026-desktop-diagnostics-proof-surface.md`
- `roadmaps/g02/027-diagnostics-read-model-source-integration.md`
- `roadmaps/g02/028-next-product-workflow-selection.md`
- `roadmaps/g02/029-health-and-module-boundary-reset.md`
- `roadmaps/g02/030-task-backed-agent-workflow-contract-reset.md`
- `roadmaps/g02/031-task-agent-work-unit-source-model.md`
- `roadmaps/g02/032-codex-task-runtime-admission-bridge.md`
- `roadmaps/g02/033-codex-task-event-ingestion-and-receipts.md`
- `roadmaps/g02/034-task-work-checkpoint-and-review-loop.md`
- `roadmaps/g02/035-desktop-task-agent-progress-proof.md`
- `roadmaps/g02/036-task-backed-workflow-validation-and-next-lane.md`
- `roadmaps/g02/037-repo-backed-management-sync-hardening.md`
- `roadmaps/g02/038-management-sync-apply-and-review.md`
- `roadmaps/g02/039-scm-management-capture-and-share-foundation.md`
- `roadmaps/g02/040-git-management-capture-adapter-proof.md`
- `roadmaps/g02/041-scm-working-session-execution-prep.md`
- `roadmaps/g02/042-change-request-preparation-boundary.md`
- `roadmaps/g02/043-steward-scm-sync-automation-gate.md`
- `roadmaps/g02/044-scm-workflow-closeout-and-next-phase-selection.md`
- `roadmaps/g02/045-god-file-health-gate-rebaseline.md`
- `roadmaps/g02/046-management-projection-state-test-split.md`
- `roadmaps/g02/047-scm-work-sessions-module-split.md`
- `roadmaps/g02/048-diagnostics-read-model-test-split.md`
- `roadmaps/g02/049-engine-management-sync-test-split.md`
- `roadmaps/g02/050-management-projection-apply-import-split.md`
- `roadmaps/g02/051-change-request-prep-module-split.md`
- `roadmaps/g02/052-health-reset-validation-and-next-runtime-lane.md`
- `roadmaps/g02/053-harness-runtime-rebaseline.md`
- `roadmaps/g02/054-codex-live-event-acceptance.md`
- `roadmaps/g02/055-codex-process-and-transport-acceptance.md`
- `roadmaps/g02/056-codex-live-spawn-smoke-gate.md`
- `roadmaps/g02/057-codex-turn-start-admission-gate.md`
- `roadmaps/g02/058-codex-turn-start-send-and-subscription-gate.md`
- `roadmaps/g02/059-codex-callback-response-gate.md`
- `roadmaps/g02/060-codex-provider-interruption-gate.md`
- `roadmaps/g02/061-codex-session-recovery-gate.md`
- `roadmaps/g02/062-provider-runtime-materialisation-gate.md`
- `roadmaps/g02/063-provider-command-reactor-gate.md`
- `roadmaps/g02/064-codex-live-provider-send-readiness.md`
- `roadmaps/g02/065-codex-turn-start-transport-executor-handoff.md`
- `roadmaps/g02/066-task-backed-workflow-hardening.md`
- `roadmaps/g02/067-codex-direct-connection-smoke-gate.md`
- `roadmaps/g02/068-codex-live-executor-integration.md`
- `roadmaps/g02/069-codex-task-backed-live-execution-gate.md`
- `specs/004-display-window-surface-layout.md`
- `architecture/t3-code-comparison.md`
- `architecture/architecture-gap-index.md`
- `architecture/implementation-gap-index.md`

## Guardrail

Do not widen provider-reaching cancellation, resume execution, task mutation,
remote transport, or UI sync controls until the Codex session recovery gate
proves provider diagnostics routing, provider-service ownership, provider
instance registry shape, and provider runtime orchestration linkage without
provider execution, raw payload retention, or task mutation. The god-file
doctor gate is a recorded health blocker and warning-sized files remain
pressure when touched.

Codex `turn/start` transport-executor handoff is complete through authority
records, sanitized execution envelopes, persistence, first-response frame
evidence, diagnostics, and a stopped-by-default real-write smoke boundary.

The first approved direct Codex `turn/start` smoke completed through local
Codex app-server with sanitized output only. Task-state mutation remains
blocked behind the task-backed live execution gate.

Harness mediation and next-task selection are now explicit contract surfaces.
Tool integrations should prefer low-cardinality portal tools, such as one
Effigy tool family with typed actions, over large flat tool lists. Next-task
pointers must come from roadmaps, task queues, goals, planning artifacts,
recovery paths, validation repair paths, or operator instructions; they must
not be invented for ceremony.
blocked. The current lane moves durable dispatch records toward an explicitly
operator-gated server-owned invocation path, then provider session/frame
persistence and task-transition admission from live observations.
