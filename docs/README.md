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

`g04` product workflow vertical slice is complete. `g05` consolidates the
product from the app shell inward, starting with project-scoped workspace
layouts and Agent Chat-only new-project defaults. Durable Agent Chat, low-cardinality
`task_ledger` and `task_workflow` portals, Goals, Tasks, CodeMirror editing,
task-attributed Diff review, persisted review notes, and review-guided rework
are in place. Product use disproved the inherited hosted-Surface layer. The
workspace hierarchy is now `display -> window -> region -> panel`; the working
panel workflow and multi-window foundation remain. Native primary-window
geometry persistence is confirmed. The floating Agent Chat composer is the
current baseline. The host-routed Terminal panel and xterm slice are validated
without making Tauri the durable terminal API.
The former Context placeholder now migrates to a read-only Memory panel over
accepted-memory and proposal summaries; its operator validation is current.
Projects now generalize beyond repository bookmarks: durable scopes may be
created by name with zero resources, compact lifecycle controls are validated,
and the host-owned attach/update/repair/remove boundary detects plain folders
and Git worktrees. Compact resource management and conditional panel targeting
are now in place and multi-resource validation is complete. Agent Chat model
discovery, live sessions, turns, callbacks,
deadlines, and cleanup now use the shared Codex adapter behind the existing
Nucleus facade, with automated and authenticated native parity complete. The
product Goal/task executor now uses the Nucleus-owned `TaskExecutionRuntime`
port over Swallowtail's bounded workspace session while preserving existing
linkage, receipts, checkpoints, diffs, wait states, and review semantics. The
separately gated daemon diagnostic smoke now uses Swallowtail's read-only
session path too; no Nucleus-owned live Codex JSON-RPC client remains.
Authenticated and native two-task Goal execution parity is confirmed.
Transient restart, expiry, active-turn protection, resource-free chat, and
in-place promotion are validated. Shared project files are an optional
advanced project capability. Explicit Git-resource binding, server-owned
policy and health, project-scoped export/import routing, and project-menu
controls are validated.

Swallowtail's first publication is now held for application-scale consumer
proof. Nucleus roadmap g05.003 completed isolated desktop state, bounded Agent
Chat deadlines, normal cancellation, exact terminal persistence, explicit
Effigy proof selectors, and count-only read-only evidence. Swallowtail card
041 then passed all 12 planned native outcomes at the exact 15-attempt and
6-session ceiling after fixing 2 deterministic facade defects. Sustained live
work and every writable attempt remain separately gated. Roadmap g05.005 now
carries Swallowtail's portable observable activity through Nucleus persistence
and the desktop into Poodle's transcript components. Deterministic and
authenticated native activity, grouping, scroll, cancellation, cleanup, and
restart acceptance pass.
Roadmaps g05.006 and g05.007 now extend that boundary with typed mid-turn
questions, immutable normal/plan session selection, and lossless provider
actor, task-list, and subagent snapshot persistence. Agent Chat composes
questions through Poodle and presents provider plans and checklists without
promoting them into Nucleus Tasks. Operation-local child directory folding,
durable selection, and attributed transcript navigation now pass deterministic
acceptance. Authenticated native acceptance now passes Plan selection, typed
question presentation, durable answer recording, exact-turn continuation,
child lifecycle attribution, root/child cleanup, restart-safe child selection,
and a separate Normal-mode portable task-list case. Explicit item statuses
survive persistence and render without inventing absent provider priority.
Native operator acceptance now confirms distinct layouts survive project
switching and a previously unseen project opens with Agent Chat only.
The Longhorn desktop migration is now closed: storage, the protected primary
window, registered project layouts, renderer reconciliation, and native Browser
islands use shared mechanisms. Nucleus retains product and Browser policy and
does not depend on Longhorn Surface hosting.
The next g05 sequence admits further Longhorn mechanisms behind a strict
consumer boundary. It starts by decomposing retained migration adapters, then
adds a sparse Settings shell, provider and product settings, commands and
keymaps, cross-panel operations, retained notifications, and backup/recovery.
Local bridge alignment follows. Production remote transport and secondary
window transfer stay gated by missing product contracts. Hosted Surfaces,
generic history, isolated/backing native content, native notifications, and
offline queues remain explicit non-adoptions.
The admission batch is complete. Nucleus now owns a repeatable private-artifact
consumer check, and storage/profile/layout integration is split into focused
modules. The Settings registry, typed config authority, sparse modal, lazy
consumer pages, staged/immediate sessions, and multi-webview Tauri adapter are
implemented. Deterministic and native acceptance pass, including shared-domain
sibling refresh, reset, and restart. Settings now also show the configured
local Codex instance and model discovery, and persist new-session model,
reasoning, and harness-mode defaults without rewriting existing sessions.
Opaque credential posture and lifecycle requests are now visible without
credential material; provider-managed Codex actions return explicit no-effect
receipts. Settings acceptance is closed with an intentionally sparse product
registry: General, Appearance, and Agent & models are the only pages backed by
durable user-preference schemas. Keybindings, Storage, and Backups are
capability-bound shared operational pages. Native narrow-window and restart
proof passes. The
current command catalogue registers 27 semantic actions behind rooted contexts,
coded product availability, fresh Longhorn admission, and a typed Nucleus
executor port. Command ids remain separate from product routes and transport
ids. The default physical-key preset and durable sparse overrides now resolve
per platform with explicit conflicts, reserved chords, input ownership,
digest-bound mutation, reset, and restart behavior. The compact command palette,
keybindings, cross-panel operations, retained attention, explicit backup
capture, host-selected export, exact seven-domain grouped restore, and the local
control bridge are now composed. Restore carries present/absent target and
rollback evidence, deletes absent file and SQLite targets inside the grouped
transaction, and runs before product authorities open. Remote transport and
secondary windows retain their contract and product gates. Implemented-lane
adoption conformance and isolated native restore acceptance pass. The
operator product checkpoint passes. Roadmap g05.020 now completes one local
project working context across Goal, Task, Agent Chat, Diff, Projects, and
Threads without adding normal-path shell controls. Goal and Task focus survives
Tasks closure, project switching, and restart; Agent Chat panel conversation
attachments remain local presentation state rather than product authority.
Roadmap g05.021 now closes the Editor, task-attributed Diff, durable review, and
Agent Chat rework loop. Diff carries exact snapshot resource identity, refuses
unknown lineage, and exposes one compact Address changes action. That action
retains the selected Task and any existing draft, appends a bounded prompt, and
waits for an explicit operator send. Deterministic and isolated native
acceptance pass without authenticated provider work.
Roadmap g05.022 now closes Terminal, Browser, resource targeting, and runtime
host status as one sparse shell lane. Terminal uses the same exact effective
resource in panel chrome and host invocation, reports only confirmed non-local
host identity, and rejects remote authority before touching local paths.
Browser remains a local URL-driven native child with bounded panel-local retry.
Current-bundle native acceptance confirms Terminal and Browser body switching,
theme-aligned Terminal output, Browser return, toolbar overlay admission, and
active-panel restart restoration.
Roadmap g05.023 now closes bounded Memory, provider selection, session defaults,
and advanced-control placement. Accepted and proposed Memory remain distinct
and read-only; restricted content is redacted and technical evidence stays
behind Details. Nucleus assembles Swallowtail's configured-provider-instance
catalogue, projects only safe identity and readiness, keeps model and reasoning
options route-scoped, and replaces immutable sessions when provider, model,
reasoning, harness, or resource identity changes. One ready provider adds no
selector. Multiple ready providers use the same explicit Settings and composer
selection path. Credential, destructive, and diagnostic controls remain behind
deliberate Settings, menu, confirmation, or disclosure entry points.
Roadmap g05.024 closes the first shell-inward pass around semantic
interaction, container-relative panel layout, and bounded local recovery. It
does not add a focus manager, durable breakpoint state, generic retry executor,
or global status chrome. Supported-minimum native acceptance keeps project,
Agent Chat, and Tasks controls usable without normal-chrome horizontal scroll.

Current planning artifacts:

- `research/translation-memos/editor-substrate-selection.md`
- `specs/006-initial-code-editor-vertical-slice.md`
- `specs/007-task-attributed-diff-review.md`
- `roadmaps/g04/028-initial-code-editor-vertical-slice.md`
- `roadmaps/g04/029-task-attributed-diff-review.md`
- `roadmaps/g04/030-review-guided-rework-execution.md`
- `roadmaps/g04/031-window-region-panel-simplification.md`
- `roadmaps/g04/032-native-window-geometry-persistence.md`
- `specs/010-floating-agent-chat-composer.md`
- `roadmaps/g04/033-floating-agent-chat-composer.md`
- `contracts/029-terminal-panel-runtime-contract.md`
- `roadmaps/g04/035-host-routed-terminal-panel.md`
- `roadmaps/g04/036-project-memory-panel.md`
- `specs/012-flexible-project-lifecycle-and-resources.md`
- `specs/013-shared-agent-runtime-extraction.md`
- `contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `contracts/031-swallowtail-task-execution-runtime-contract.md`
- `architecture/project-resource-lifecycle.md`
- `roadmaps/g04/037-project-resource-foundation.md`
- `roadmaps/g04/038-project-control-workflow.md`
- `roadmaps/g04/039-multi-resource-attachment-and-targeting.md`
- `roadmaps/g04/040-transient-chat-and-promotion.md`
- `roadmaps/g04/041-shared-project-files-control.md`
- `roadmaps/g04/049-swallowtail-agent-chat-adoption.md`
- `roadmaps/g04/050-swallowtail-task-execution-adoption.md`
- `roadmaps/g05/001-project-scoped-workspace-layouts.md`
- `roadmaps/g05/003-swallowtail-application-proof-readiness.md`
- `roadmaps/g05/005-observable-agent-chat-transcript.md`
- `roadmaps/g05/006-interactive-agent-chat-sessions.md`
- `roadmaps/g05/007-structured-provider-work.md`
- `roadmaps/g05/008-structured-agent-chat-acceptance.md`
- `contracts/032-longhorn-desktop-systems-integration-contract.md`
- `roadmaps/g05/009-longhorn-secondary-system-admission.md`
- `roadmaps/g05/010-longhorn-settings-shell.md`
- `roadmaps/g05/011-provider-and-product-settings.md`
- `roadmaps/g05/012-command-catalogue-keymaps-and-palette.md`
- `roadmaps/g05/013-cross-panel-operation-catalogue.md`
- `roadmaps/g05/014-notification-ledger-and-attention.md`
- `roadmaps/g05/015-backup-restore-and-recovery-controls.md`
- `roadmaps/g05/016-optional-backend-bridge-alignment.md`
- `roadmaps/g05/017-secondary-window-panel-transfer.md`
- `roadmaps/g05/018-longhorn-adoption-closeout-and-deferrals.md`
- `roadmaps/g05/019-shell-context-cohesion.md`
- `roadmaps/g05/020-shared-work-context.md`
- `roadmaps/g05/021-editor-diff-review-rework-cohesion.md`
- `roadmaps/g05/022-terminal-browser-resource-host-cohesion.md`
- `logs/2026-08-04-terminal-browser-resource-host-cohesion.md`
- `logs/2026-08-03-shell-context-cohesion.md`
- `logs/2026-08-03-shared-work-context.md`
- `logs/2026-08-01-longhorn-secondary-system-roadmap-compilation.md`
- `logs/2026-08-01-longhorn-consumer-admission-closeout.md`
- `logs/2026-08-02-longhorn-settings-shell-implementation.md`
- `logs/2026-07-31-interactive-structured-agent-chat.md`
- `logs/2026-07-30-observable-agent-chat-transcript.md`
- `logs/2026-08-01-longhorn-desktop-migration-closeout.md`

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
