# g04 Product Workflow Vertical Slice

Status: active
Owner: Tom
Updated: 2026-07-15

## Purpose

Turn the large set of server proofs from g01-g03 into a coherent product
workflow.

G04 is not another subsystem-deepening generation. Its job is to prove that a
user can move through a Nucleus-shaped project workflow: select a project,
inspect tasks and planning context, delegate bounded work, watch evidence,
review results, and understand the next step without clients becoming state
authorities.

## Generation Runway

Current generation goal:

- prove a product-shaped workflow across project, task, planning, agent
  runtime, evidence, review, and SCM readiness surfaces before widening memory,
  provider, SCM, panel, or final UI implementation

Current runway bands:

- product workflow rebaseline and vertical-slice selection
- server-side workflow summary/read model over existing records
- `nucleusd` and Effigy inspection for the workflow summary
- disposable desktop proof surface that shows the workflow without final UI
  commitments
- task-backed agent work loop hardening from existing Codex/runtime evidence
- review/acceptance/next-task presentation without automatic task mutation
- SCM readiness handoff as a practical user workflow, not more provider
  execution
- deferred-lane checkpoints for memory, provider, SCM, panel, and UI work

Current checkpoint:

- g03 closed after accepted-memory review receipt persistence and stopped
  active-apply admission diagnostics
- accepted-memory active apply executor is superseded and deferred
- `docs/roadmaps/deferred-lanes.md` tracks valid return-later lanes
- the first product workflow slice is validated
- source composition for existing planning, context, runtime, review, SCM, and
  next-step records is validated
- the task workflow drilldown boundary, read model, DTOs, CLI, and Effigy
  selector are validated
- the disposable desktop proof for the selected-task drilldown is in place
- the task workflow drilldown lane is validated and the next lane is selected
- the active path is selected-task work-loop composition
- the selected-task work-loop boundary and source map are defined
- selected-task read-only guidance is now part of the task workflow drilldown
- the disposable desktop proof now composes selected task, project workflow,
  guidance, review readiness, and handoff readiness
- selected-task work-loop composition is validated
- the active path is selected-task action readiness
- the selected-task action readiness boundary and read model are in place
- selected-task action readiness has CLI, control DTO, and Effigy inspection
- selected-task action readiness is visible in the disposable desktop proof
- selected-task action readiness is validated
- the active path is selected-task operator action gate
- selected-task operator task-action boundary and read-only gate are in place
- selected-task operator action gate has CLI and Effigy inspection
- selected-task operator action gate is visible in the disposable desktop proof
- selected-task operator action gate is validated
- the active path is selected-task task-command admission controls
- selected-task command admission boundary and server proof are in place
- selected-task command admission has CLI and Effigy dry-run inspection
- selected-task command admission has disposable desktop proof controls
- selected-task command admission is validated
- the active path is task-command outcome coherence
- task-command shell refresh boundary is in place
- task-command desktop refresh loop is in place
- task-command receipt and timeline presentation is in place
- task-command outcome coherence is validated
- the active path is selected-task review and next-step presentation
- selected-task review/next boundary and server read model are in place
- selected-task review/next has control DTOs, CLI, and Effigy inspection
- selected-task review/next is visible in the disposable desktop proof
- selected-task review/next is validated
- the active path is selected-task SCM handoff readiness
- selected-task SCM handoff readiness boundary and source map are defined
- selected-task SCM handoff readiness server read model is in place
- selected-task SCM handoff readiness has control DTOs, CLI, and Effigy
  inspection
- selected-task SCM handoff readiness is visible in the disposable desktop
  proof
- selected-task SCM handoff readiness is validated
- the active path is g04 product workflow closeout and next-phase selection
- g04 vertical-slice evidence inventory is complete
- deferred lanes are compared against current product gaps
- next phase selected: selected-task review decision controls
- product workflow closeout validation is complete
- selected-task review-decision boundary and pure admission are in place
- selected-task review-decision records and read-model refresh are in place
- selected-task review-decision CLI, Effigy, and desktop proof controls are in
  place
- selected-task review-decision controls are validated
- the active path is selected-task review outcome routing
- selected-task review outcome-routing boundary and pure read model are in
  place
- selected-task review outcome routing has control DTO, `nucleusd`, and Effigy
  inspection
- selected-task review outcome routing is visible in the disposable desktop
  proof
- selected-task review outcome routing is validated
- the active path is selected-task route admission
- selected-task route-admission boundary and stop conditions are defined
- selected-task accepted-review completion route admission read model is in
  place
- selected-task rework and delegation route-admission preview shape is in
  place
- selected-task route admission has control DTOs, `nucleusd`, Effigy, and
  disposable desktop proof inspection
- selected-task route admission is validated
- the active path is selected-task completion from route admission
- selected-task completion-from-route boundary and pure composition model are
  in place
- selected-task completion-from-route has control DTOs, `nucleusd`, and Effigy
  read-only preview inspection
- selected-task completion-from-route is visible in the disposable desktop
  proof as a disabled read-only apply preview
- the selected-task workflow proof is isolated behind a top-level desktop modal
  launcher so the main UI can be replaced cleanly later
- selected-task completion-from-route is validated
- the active path is selected-task rework from review outcome
- selected-task rework-from-review boundary and authority map are defined
- selected-task rework preparation pure server model is in place
- selected-task rework preparation has read-only control, CLI, and Effigy
  inspection
- selected-task rework preparation renders in the disposable desktop proof
  modal without enabling work-item creation or scheduling
- selected-task rework-from-review is validated
- the active path is selected-task delegation scheduling admission
- selected-task delegation scheduling boundary and authority map are defined
- selected-task delegation scheduling implementation is paused until the real
  product workflow UI architecture is defined
- the active path is product workflow UI architecture refocus
- disposable task workflow proof is frozen as diagnostic-only
- product workflow UI architecture refocus is complete
- the active path is workspace hosting model extraction before final product
  shell implementation
- workspace hosting model extraction is complete at the Rust type/pure-helper
  level
- selected-task product aggregate query is paused until the first product shell
  project rail/stage exists
- the active path is product shell project rail
- the active project workspace stage is in place without moving proof widgets
  into the product shell
- read-only product task navigation was tried inside the active project
  workspace stage, then rolled back from the normal workspace
- product shell project rail is validated and complete
- the active path is selected-task product aggregate query
- selected-task aggregate contract and source map are defined
- selected-task aggregate pure server read model is in place
- selected-task aggregate has control DTOs, `nucleusd`, and Effigy inspection
- selected-task product aggregate query is validated and complete
- the active path is selected-task aggregate product shell placement
- selected-task aggregate product shell placement was superseded and rolled
  back from the normal workspace
- the active path is product shell design checkpoint
- the approved workspace shell and first proper Agent Chat and Tasks panels are
  in place
- durable Goals now group ordered task runways without removing ungrouped tasks
- Agent Chat exposes the low-cardinality `task_ledger` and `task_workflow`
  portals
- one explicit operator message can run one task or one frozen Goal snapshot
  through real serial local Codex execution
- the Agent Chat Goal workflow run is complete
- CodeMirror 6 is selected as the first client editor substrate
- the host-authorized one-buffer editor vertical slice is complete
- editor-to-diff/review is selected as the next product lane
- task-attributed checkpoint review is selected over generic working-copy
  review
- source snapshot, transient patch, and compact Diff panel rules are promoted
- the task-attributed review roadmap and five-card runway are ready
- the host-local task review snapshot backend is complete
- task-run checkpoint and diff integration is complete
- the task diff read API and Tauri boundary are complete
- the compact selected-task Diff review panel is complete
- the typed task diff read and Tauri boundary is complete
- the active path is the compact task Diff review panel
- review-guided rework execution is complete
- the hosted-Surface metaphor was reassessed from product use and removed
- desktop config now persists direct window regions and migrates the former
  active Surface from schema v1
- `nucleus-workspaces` now models display/window/region/panel without hosted
  Surface identity or lifecycle
- the window/region/panel simplification lane is complete
- native primary-window geometry persistence is confirmed and complete
- the floating Agent Chat composer with functional route controls is accepted
- the active path is the four-main-region workspace grid
- the four-main-region, host-routed Terminal, and read-only Memory lanes are
  validated and closed
- the flexible project model is promoted: projects may be transient or durable
  and contain zero or many folder or Git resources
- project resource foundation, minimal control, multi-resource targeting,
  transient chat, and optional Shared project files are the next sequenced
  product roadmaps
- workspace actions now resolve explicit, configured-default, or sole working
  resources on the host and retain panel/task resource attribution
- compact project resource management now handles attach, default, repair,
  and removal while keeping ordinary one-resource panels free of topology UI

## Roadmaps

- `001-product-workflow-rebaseline-and-vertical-slice.md` - completed
- `002-product-workflow-source-composition.md` - completed
- `003-task-workflow-drilldown-and-handoff-readiness.md` - completed
- `004-selected-task-work-loop-composition.md` - completed
- `005-selected-task-action-readiness.md` - completed
- `006-selected-task-operator-action-gate.md` - completed
- `007-selected-task-command-admission-controls.md` - completed
- `008-task-command-outcome-coherence.md` - completed
- `009-selected-task-review-next-step-presentation.md` - completed
- `010-selected-task-scm-handoff-readiness.md` - completed
- `011-product-workflow-closeout-and-next-phase-selection.md` - completed
- `012-selected-task-review-decision-controls.md` - completed
- `013-selected-task-review-outcome-routing.md` - completed
- `014-selected-task-route-admission.md` - completed
- `015-selected-task-completion-from-route-admission.md` - completed
- `016-selected-task-rework-from-review-outcome.md` - completed
- `017-selected-task-delegation-scheduling-admission.md` - paused
- `018-product-workflow-ui-architecture-refocus.md` - completed
- `019-workspace-hosting-model-extraction.md` - completed
- `020-selected-task-product-aggregate-query.md` - completed
- `021-product-shell-project-rail.md` - completed
- `022-selected-task-aggregate-product-shell-placement.md` - superseded
- `023-product-shell-design-checkpoint.md` - completed
- `024-workspace-surface-shell-skeleton.md` - completed
- `025-initial-agent-chat-vertical-slice.md` - completed
- `026-agent-chat-task-context.md` - completed
- `027-agent-chat-task-workflow-run.md` - completed
- `028-initial-code-editor-vertical-slice.md` - completed
- `029-task-attributed-diff-review.md` - completed
- `030-review-guided-rework-execution.md` - completed
- `031-window-region-panel-simplification.md` - completed
- `032-native-window-geometry-persistence.md` - completed
- `033-floating-agent-chat-composer.md` - completed
- `034-four-main-region-workspace-grid.md` - completed
- `035-host-routed-terminal-panel.md` - completed
- `036-project-memory-panel.md` - completed
- `037-project-resource-foundation.md` - completed
- `038-project-control-workflow.md` - completed
- `039-multi-resource-attachment-and-targeting.md` - active
- `040-transient-chat-and-promotion.md` - planned
- `041-shared-project-files-control.md` - planned

## Batch Cards

Ready cards:

- `batch-cards/193-multi-resource-workflow-validation.md`

Completed cards:

- `batch-cards/185-project-resource-control-boundary.md`
- `batch-cards/186-project-resource-foundation-validation.md`
- `batch-cards/187-project-lifecycle-command-boundary.md`
- `batch-cards/188-minimal-project-rail-controls.md`
- `batch-cards/189-project-control-validation.md`
- `batch-cards/190-resource-attachment-and-repair-boundary.md`
- `batch-cards/191-workspace-resource-target-resolution.md`
- `batch-cards/192-compact-project-resource-controls.md`

Planned cards:

- `batch-cards/194-transient-project-retention-boundary.md`
- `batch-cards/195-new-chat-and-in-place-promotion.md`
- `batch-cards/196-transient-chat-validation.md`
- `batch-cards/197-management-projection-resource-binding.md`
- `batch-cards/198-shared-project-files-controls.md`
- `batch-cards/199-shared-project-files-validation.md`

Paused cards:

- `batch-cards/081-selected-task-delegation-work-item-admission.md`
- `batch-cards/082-selected-task-delegation-control-surfaces.md`
- `batch-cards/083-selected-task-delegation-desktop-proof.md`
- `batch-cards/084-selected-task-delegation-validation-next-lane.md`

Superseded cards:

- `batch-cards/105-product-shell-task-list-placement.md`
- `batch-cards/107-selected-task-aggregate-shell-placement-boundary.md`
- `batch-cards/108-selected-task-aggregate-workspace-panel.md`
- `batch-cards/109-selected-task-aggregate-shell-state-hardening.md`
- `batch-cards/110-selected-task-aggregate-shell-validation-next-lane.md`

Completed cards:

- `batch-cards/184-project-resource-domain-and-storage.md`
- `batch-cards/182-memory-panel-validation.md`
- `batch-cards/179-terminal-runtime-validation.md`
- `batch-cards/176-four-main-region-validation-checkpoint.md`
- `batch-cards/183-project-resource-model-promotion.md`
- `batch-cards/181-read-only-memory-panel.md`
- `batch-cards/180-context-to-memory-migration.md`
- `batch-cards/156-task-diff-read-api-and-tauri-boundary.md`
- `batch-cards/155-task-run-checkpoint-diff-integration.md`
- `batch-cards/154-task-review-source-snapshot-backend.md`
- `batch-cards/153-editor-validation-and-next-lane-checkpoint.md`
- `batch-cards/152-editor-quick-open-language-theme-and-conflicts.md`
- `batch-cards/151-codemirror-editor-panel-vertical-slice.md`
- `batch-cards/150-editor-file-authority-and-control-boundary.md`
- `batch-cards/149-task-workflow-portal-receipts-and-live-validation.md`
- `batch-cards/148-goal-run-provider-dispatch-bridge.md`
- `batch-cards/147-goal-run-inspection-and-admission.md`
- `batch-cards/146-goal-mandate-turn-start-boundary.md`
- `batch-cards/145-goal-grouped-task-panel-and-chat-context.md`
- `batch-cards/144-task-ledger-goal-authoring.md`
- `batch-cards/143-goal-domain-and-task-membership.md`
- `batch-cards/137-task-workflow-portal-design-review.md`
- `batch-cards/136-task-ledger-portal-consolidation.md`
- `batch-cards/135-agent-chat-task-context-closeout.md`
- `batch-cards/134-active-task-conversation-context.md`
- `batch-cards/133-agent-task-workflow-direction-checkpoint.md`
- `batch-cards/132-agent-task-inspection-and-update.md`
- `batch-cards/131-proper-task-panel-foundation.md`
- `batch-cards/130-agent-task-workflow-checkpoint.md`
- `batch-cards/129-live-agent-task-authoring-validation.md`
- `batch-cards/128-agent-task-creation-receipts.md`
- `batch-cards/127-agent-task-authoring-tool.md`
- `batch-cards/126-chat-task-context-design-review.md`
- `batch-cards/125-durable-agent-chat-continuity.md`
- `batch-cards/124-agent-chat-product-design-review.md`
- `batch-cards/123-local-agent-chat-vertical-slice.md`
- `batch-cards/122-project-rail-resizable-shell-split.md`
- `batch-cards/121-empty-region-collapse-and-drop-target-reveal.md`
- `batch-cards/120-panel-cross-region-drag-drop-hardening.md`
- `batch-cards/119-panel-recovery-menu-and-resizable-regions.md`
- `batch-cards/118-surface-panel-placement-validation.md`
- `batch-cards/117-surface-panel-placement-policy-feedback.md`
- `batch-cards/116-product-workflow-ui-design-review.md`
- `batch-cards/111-product-shell-design-review-checkpoint.md`
- `batch-cards/112-product-shell-design-direction-promotion.md`
- `batch-cards/113-local-workspace-ui-config-boundary.md`
- `batch-cards/114-desktop-surface-tabs-and-regions.md`
- `batch-cards/115-workspace-surface-shell-validation.md`
- `batch-cards/001-product-workflow-lane-boundary.md`
- `batch-cards/002-product-workflow-read-model.md`
- `batch-cards/003-product-workflow-cli-effigy-inspection.md`
- `batch-cards/004-disposable-product-workflow-proof.md`
- `batch-cards/005-product-workflow-validation-next-lane.md`
- `batch-cards/006-product-workflow-planning-context-composition.md`
- `batch-cards/007-product-workflow-memory-research-composition.md`
- `batch-cards/008-product-workflow-runtime-review-composition.md`
- `batch-cards/009-product-workflow-scm-next-composition.md`
- `batch-cards/010-product-workflow-source-composition-validation.md`
- `batch-cards/011-task-workflow-drilldown-boundary.md`
- `batch-cards/012-task-workflow-drilldown-read-model.md`
- `batch-cards/013-task-workflow-drilldown-cli-effigy.md`
- `batch-cards/014-disposable-task-workflow-drilldown-proof.md`
- `batch-cards/015-task-workflow-drilldown-validation-next-lane.md`
- `batch-cards/016-selected-task-work-loop-boundary.md`
- `batch-cards/017-selected-task-work-loop-guidance-read-model.md`
- `batch-cards/018-selected-task-work-loop-desktop-composition.md`
- `batch-cards/019-review-scm-handoff-gap-presentation.md`
- `batch-cards/020-selected-task-work-loop-validation-next-lane.md`
- `batch-cards/021-selected-task-action-readiness-boundary.md`
- `batch-cards/022-selected-task-action-readiness-read-model.md`
- `batch-cards/023-selected-task-action-readiness-cli-effigy.md`
- `batch-cards/024-selected-task-action-readiness-desktop-proof.md`
- `batch-cards/025-selected-task-action-readiness-validation-next-lane.md`
- `batch-cards/026-selected-task-operator-action-boundary.md`
- `batch-cards/027-selected-task-operator-action-gate-read-model.md`
- `batch-cards/028-selected-task-operator-action-cli-effigy.md`
- `batch-cards/029-selected-task-operator-action-desktop-proof.md`
- `batch-cards/030-selected-task-operator-action-validation-next-lane.md`
- `batch-cards/031-selected-task-command-admission-boundary.md`
- `batch-cards/032-selected-task-command-admission-proof.md`
- `batch-cards/033-selected-task-command-cli-effigy.md`
- `batch-cards/034-selected-task-command-desktop-proof-controls.md`
- `batch-cards/035-selected-task-command-validation-next-lane.md`
- `batch-cards/036-task-command-refresh-boundary.md`
- `batch-cards/037-task-command-desktop-refresh-loop.md`
- `batch-cards/038-task-command-receipt-timeline-presentation.md`
- `batch-cards/039-task-command-outcome-validation-next-lane.md`
- `batch-cards/040-selected-task-review-next-boundary.md`
- `batch-cards/041-selected-task-review-next-read-model.md`
- `batch-cards/042-selected-task-review-next-cli-effigy.md`
- `batch-cards/043-selected-task-review-next-desktop-proof.md`
- `batch-cards/044-selected-task-review-next-validation.md`
- `batch-cards/045-selected-task-scm-handoff-boundary.md`
- `batch-cards/046-selected-task-scm-handoff-read-model.md`
- `batch-cards/047-selected-task-scm-handoff-cli-effigy.md`
- `batch-cards/048-selected-task-scm-handoff-desktop-proof.md`
- `batch-cards/049-selected-task-scm-handoff-validation.md`
- `batch-cards/050-g04-vertical-slice-evidence-inventory.md`
- `batch-cards/051-deferred-lane-gap-comparison.md`
- `batch-cards/052-next-phase-decision-runway.md`
- `batch-cards/053-product-workflow-closeout-validation.md`
- `batch-cards/054-selected-task-review-decision-boundary.md`
- `batch-cards/055-selected-task-review-decision-admission.md`
- `batch-cards/056-selected-task-review-decision-records.md`
- `batch-cards/057-selected-task-review-decision-cli-effigy.md`
- `batch-cards/058-selected-task-review-decision-desktop-proof.md`
- `batch-cards/059-selected-task-review-decision-outcome-validation.md`
- `batch-cards/060-selected-task-review-outcome-boundary.md`
- `batch-cards/061-selected-task-review-outcome-read-model.md`
- `batch-cards/062-selected-task-review-outcome-cli-effigy.md`
- `batch-cards/063-selected-task-review-outcome-desktop-proof.md`
- `batch-cards/064-selected-task-review-outcome-validation.md`
- `batch-cards/065-selected-task-route-admission-boundary.md`
- `batch-cards/066-selected-task-completion-admission-read-model.md`
- `batch-cards/067-selected-task-rework-delegation-admission-shape.md`
- `batch-cards/068-selected-task-route-admission-surfaces.md`
- `batch-cards/069-selected-task-route-admission-validation.md`
- `batch-cards/070-selected-task-completion-route-apply-boundary.md`
- `batch-cards/071-selected-task-completion-route-command-composition.md`
- `batch-cards/072-selected-task-completion-route-control-surfaces.md`
- `batch-cards/073-selected-task-completion-route-desktop-proof.md`
- `batch-cards/074-selected-task-completion-route-validation.md`
- `batch-cards/075-selected-task-rework-route-apply-boundary.md`
- `batch-cards/076-selected-task-rework-work-item-composition.md`
- `batch-cards/077-selected-task-rework-control-surfaces.md`
- `batch-cards/078-selected-task-rework-desktop-proof.md`
- `batch-cards/079-selected-task-rework-validation-next-lane.md`
- `batch-cards/080-selected-task-delegation-scheduling-boundary.md`
- `batch-cards/086-selected-task-workflow-shell-architecture.md`
- `batch-cards/087-selected-task-server-surface-fit.md`
- `batch-cards/088-product-workflow-implementation-runway-reset.md`
- `batch-cards/089-ui-refocus-validation-next-lane.md`
- `batch-cards/090-echo-windowing-port-map.md`
- `batch-cards/091-workspace-display-window-types.md`
- `batch-cards/092-window-planning-fallback-helpers.md`
- `batch-cards/093-hosted-surface-lifecycle-model.md`
- `batch-cards/094-region-panel-project-adaptation-boundary.md`
- `batch-cards/095-local-layout-persistence-boundary.md`
- `batch-cards/096-workspace-hosting-validation-next-lane.md`
- `batch-cards/097-selected-task-aggregate-contract.md`
- `batch-cards/098-selected-task-aggregate-read-model.md`
- `batch-cards/099-selected-task-aggregate-control-dto.md`
- `batch-cards/100-selected-task-aggregate-cli-effigy.md`
- `batch-cards/101-selected-task-aggregate-product-client-adapter.md`
- `batch-cards/102-selected-task-aggregate-validation-next-lane.md`
- `batch-cards/103-product-shell-project-rail-list.md`
- `batch-cards/104-active-project-workspace-stage.md`
- `batch-cards/106-product-shell-validation-next-lane.md`
- `batch-cards/085-proof-ui-freeze-and-product-workflow-boundary.md`
