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

`g04` product workflow vertical slice. The workspace shell, durable Agent Chat,
server-authorized task creation/refinement, and the first proper Tasks panel are
in place. Agent Chat can now focus the task selected in the Tasks panel without
gaining lifecycle or dispatch authority. Its task capabilities now use one
`task_ledger` portal rather than atomic query and mutation tools. Current
operator turns now persist before provider tool activity, and explicit Goal
mandates freeze the selected Goal revision and ordered task revisions. Current
pointer: compose Goal inspection and serial run admission without provider
effects.

Current planning artifacts:

- `logs/2026-06-17-stocktake.md`
- `logs/2026-06-17-g02-rollover.md`
- `logs/2026-06-18-stocktake.md`
- `logs/2026-06-19-scm-runway-closeout.md`
- `logs/2026-06-19-codex-live-smoke-evidence.md`
- `logs/2026-06-20-stocktake.md`
- `logs/2026-06-20-health-rebaseline.md`
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
- `roadmaps/g02/123-scm-change-request-adapter-plan-selection.md`
- `roadmaps/g02/124-health-and-runway-rebaseline.md`
- `roadmaps/g03/001-git-change-request-execution-gate.md`
- `roadmaps/g03/065-stopped-provider-repository-metadata-refresh-persistence.md`
- `roadmaps/g03/066-stopped-provider-pull-request-refresh-control.md`
- `roadmaps/g03/067-stopped-provider-pull-request-refresh-persistence.md`
- `roadmaps/g03/068-provider-forge-read-pattern-consolidation.md`
- `roadmaps/g03/069-provider-read-intent-projection-control.md`
- `roadmaps/g03/070-provider-read-intent-query-composition.md`
- `roadmaps/g03/071-provider-read-intent-control-boundary.md`
- `roadmaps/g03/072-provider-read-intent-boundary-rebaseline.md`
- `roadmaps/g03/073-provider-read-intent-serialized-control-envelope.md`
- `roadmaps/g03/074-provider-read-intent-nucleusd-query.md`
- `roadmaps/g03/075-provider-read-intent-tauri-ipc-consumption.md`
- `roadmaps/g03/076-provider-read-intent-product-consumption-decision.md`
- `roadmaps/g03/077-provider-readiness-overview-projection.md`
- `roadmaps/g03/078-provider-readiness-overview-query-control.md`
- `roadmaps/g03/079-provider-readiness-overview-nucleusd-query.md`
- `roadmaps/g03/080-provider-readiness-overview-tauri-ipc-consumption.md`
- `roadmaps/g03/081-provider-readiness-overview-product-consumption-decision.md`
- `roadmaps/g03/082-provider-readiness-overview-desktop-proof-surface.md`
- `roadmaps/g03/083-provider-readiness-overview-seeded-evidence-proof.md`
- `roadmaps/g03/084-provider-readiness-overview-drilldown-read-model.md`
- `roadmaps/g03/085-provider-readiness-product-closeout-and-next-lane-selection.md`
- `roadmaps/g03/086-stopped-provider-status-check-refresh.md`
- `roadmaps/g03/087-provider-readiness-coverage-and-next-provider-gate.md`
- `roadmaps/g03/088-provider-live-read-admission-gate.md`
- `roadmaps/g03/089-provider-live-read-execution-contract-and-adapter-boundary.md`
- `roadmaps/g03/090-provider-live-read-smoke-approval-gate.md`
- `roadmaps/g03/091-provider-live-read-smoke-operator-approval-checkpoint.md`
- `roadmaps/g03/092-provider-live-read-smoke-closeout-and-executor-selection.md`
- `roadmaps/g03/093-provider-live-read-server-owned-executor.md`
- `roadmaps/g03/094-provider-live-read-executor-control-surface.md`
- `roadmaps/g03/095-provider-live-read-executor-command-runner-handoff.md`
- `roadmaps/g03/096-provider-live-read-command-runner-smoke-approval.md`
- `roadmaps/g03/097-provider-live-read-approved-smoke-evidence-promotion.md`
- `roadmaps/g03/098-provider-live-read-approved-smoke-evidence-control-surface.md`
- `roadmaps/g03/099-provider-live-read-approved-smoke-evidence-persistence.md`
- `roadmaps/g03/100-provider-live-read-smoke-evidence-state-backed-query.md`
- `roadmaps/g03/101-provider-live-read-smoke-evidence-seed-replay.md`
- `roadmaps/g03/102-provider-live-read-smoke-evidence-readiness-integration.md`
- `roadmaps/g03/103-provider-live-read-second-family-selection.md`
- `roadmaps/g03/104-provider-live-read-second-family-stopped-request.md`
- `roadmaps/g03/105-provider-live-read-boundary-stocktake.md`
- `roadmaps/g03/106-provider-live-read-status-check-smoke.md`
- `roadmaps/g03/107-provider-live-read-reassessment.md`
- `roadmaps/g03/108-server-client-workflow-hardening.md`
- `roadmaps/g03/109-task-timeline-authority-map-control-parity.md`
- `roadmaps/g03/110-task-project-workflow-depth.md`
- `roadmaps/g03/111-planning-artifact-task-seed-promotion.md`
- `specs/004-display-window-surface-layout.md`
- `architecture/t3-code-comparison.md`
- `architecture/architecture-gap-index.md`
- `architecture/implementation-gap-index.md`
- `architecture/server-client-query-surface-inventory.md`
- `architecture/server-client-gap-matrix.md`
- `architecture/task-project-workflow-gap-matrix.md`
- `architecture/planning-task-seed-gap-matrix.md`

## Guardrail

G02 closed after adapter-specific SCM change-request plan selection. G03
proved the Git change-request execution chain as stopped-by-default server
records. G03 promotes that represented chain into adapter-neutral projection
and persistence surfaces before any Convergence-like publication admission or
real mutating lane.

Codex live execution, task-backed evidence review, explicit task completion,
SCM capture, operator review readiness, review decisions, adapter-neutral
change-request preparation, adapter-specific change-request planning, Git
change-request execution gates, and adapter-neutral change-request chain
projection are now proven as server-owned, sanitized, operator-gated
record/control surfaces. Provider credential-status and repository metadata
refresh surfaces are represented and persisted as stopped read-intent records;
pull-request/merge-request refresh is represented and persisted as a stopped
read-intent record. Further provider read-family fan-out is paused until the
reusable read-intent pattern is promoted into an integration surface. A generic
read-intent projection/control surface now aggregates the proven persisted read
families, and a read-only query composes that projection from local-store
records. The in-process control handler can now request that projection. The
provider read-intent boundary rebaseline permits a first serialized DTO lane,
but only for read-only aggregate/source counts and sanitized refs. The
control-envelope codec now supports that query/result shape without adding
provider effects. `nucleusd query provider-read-intent` and
`effigy server:query:provider-read-intent` now expose the read-only projection
from the root task surface. The Tauri IPC command adapter can also consume the
same serialized query without creating visible UI or provider effects.
Provider read-intent product consumption is now selected as a server-owned
Provider Readiness Overview projection before any visible UI, live provider
reads, or additional read-family fan-out. The pure overview projection,
read-only query/control integration, `nucleusd`/Effigy inspection, Tauri IPC
consumption, desktop proof surface, seeded evidence proof, drilldown read
model, and status/check read-family integration are complete. Provider
readiness now represents credential status, repository metadata, PR/MR, and
status/check evidence without live provider reads. The fixture-backed provider
live-read admission gate is complete through admission, preflight, sanitized
request/receipt planning, persistence, diagnostics, and control DTOs. The
live-read execution contract and adapter boundary is complete through contract
deltas, fixture-only client boundaries, stopped executor handoffs, and fixture
response diagnostics. The stopped live-read smoke approval gate is complete
through smoke target, credential/network authority checklist, and stopped smoke
request records. The first approved live-read smoke completed manually through
`gh` against `octocat/Hello-World` as a repository metadata refresh. The
server-owned read-only executor, command-runner handoff, command smoke
approval, promoted smoke evidence records, read-only query/DTO/`nucleusd`/
Effigy inspection, and promoted evidence persistence are now represented
without automatic provider execution.
Provider writes, task mutation, callback/interruption/recovery execution,
automatic UI-triggered provider execution, credential material storage, and raw
payload retention remain blocked.

The first approved direct Codex `turn/start` smoke completed through local
Codex app-server with sanitized output only. Further provider writes, SCM/forge
mutation, callback execution, interruption execution, recovery execution, UI
expansion, and remote-control expansion remain gated behind explicit roadmap
lanes.

Harness mediation and next-task selection are now explicit contract surfaces.
Tool integrations should prefer low-cardinality portal tools, such as one
Effigy tool family with typed actions, over large flat tool lists. Next-task
pointers must come from roadmaps, task queues, goals, planning artifacts,
recovery paths, validation repair paths, or operator instructions; they must
not be invented for ceremony.
