# Long Term Plan

Status: proposed
Owner: Tom
Updated: 2026-06-18

## Purpose

Provide a stable high-level plan so Nucleus does not keep advancing by small
ad hoc batch cards.

This plan should govern the next generations. Batch cards should only be
created inside an approved phase when the phase is ready for execution.

## Planning Rules

- Work in generations with clear themes.
- Keep batch cards as execution aids, not the planning source of truth.
- Do not open more implementation lanes until the current phase goal is
  explicit.
- Prefer phase closeouts over micro-card churn.
- Promote durable findings into architecture/contracts before implementation
  depends on them.
- Keep T3 Code as a specimen, not a template to clone blindly.

## Current G02 Runway

G02 is the orchestration and engine-core generation. Milestones 001-055 are
complete, and milestone 056 is the active Codex live spawn smoke lane.

Completed workflow proof:

- task-backed agent work unit

First bridged runtime target:

- Codex

Reason:

- this proves the core product loop most directly
- Codex supervision has the strongest existing runtime runway
- native steward and repo-backed management sync remain follow-on workflows,
  not parallel implementation lanes

Current G02 continuation sequence:

1. code-health repair for the red doctor gate - complete enough to proceed with
   doctor risk recorded
2. task-backed agent workflow contract hardening - complete
3. task work-unit source records and admission path - complete
4. Codex runtime bridge proof for task-backed work - complete
5. checkpoint/review loop for completed work units - complete
6. desktop proof surface for task-agent progress - complete
7. validation and next workflow selection - complete
8. repo-backed management sync hardening - complete
9. management sync apply and review - complete
10. SCM management capture and share foundation - complete
11. Git management capture adapter proof - complete
12. SCM working-session execution prep - complete
13. change-request preparation boundary - complete
14. steward SCM sync automation gate - complete
15. SCM workflow closeout and next phase selection - complete
16. god-file health gate rebaseline - complete
17. management projection state test split - complete
18. SCM work sessions module split - complete
19. diagnostics read-model test split - complete
20. engine management sync test split - complete
21. management projection apply/import split - complete
22. change-request prep module split - complete
23. health reset validation and next runtime lane - complete
24. harness runtime rebaseline - complete
25. Codex live event acceptance - complete
26. Codex process and transport acceptance - complete
27. Codex live spawn smoke gate - active

Selected current workflow:

- Codex live spawn smoke gate

Reason:

- task-backed agent work now has a proof path, but task/project state still
  needs committable projection discipline before multi-user workflow,
  steward automation, or richer UI work should expand
- export/import/conflict staging and explicit apply/review behavior now exist,
  including revision gates, receipts, and review read models
- provider-neutral SCM capture/share preparation now exists for accepted
  management projection changes
- Git-specific dry-run planning and sanitized status/diff evidence now exist
  without committing or pushing
- working-session execution prep now models primary-tree and isolated-location
  guard checks, cleanup policy, repair records, and no-provider-mutation gates
- provider-neutral change-request candidates, GitHub descriptor mapping, and
  evidence packages now exist without forge network calls
- steward SCM sync decision records and diagnostics now sit over
  capture/apply/review evidence without provider mutation authority
- the SCM closeout confirmed the runway is complete as record, policy, and
  diagnostics work, not as a provider-executing SCM engine
- `effigy doctor` now reports zero god-file error findings
- widening remote transport, workspace panels, or provider SCM execution would
  still distract from the next core runtime question
- harness runtime rebaseline confirmed the current Codex code is descriptor,
  fixture, compile-only supervision, wait-state, task admission, progress,
  receipt, and recovery-gate proof work
- durable Codex live event acceptance is complete as record, projection, and
  diagnostics work
- the next Phase 4 lane is Codex process and transport acceptance before
  callback, cancellation, resume, or task mutation behavior widens
- checkout, worktree creation, push, publish, promote, forge review requests,
  merge, and steward automatic sync remain later gates

This keeps execution focused on one real workflow while protecting the core
engine boundary from more proof-surface sprawl.

## Phase 0: Reassessment And Planning Base

Goal: make the planning base trustworthy.

Work:

- Review `docs/logs/2026-06-17-stocktake.md`.
- Split or summarize oversized authority surfaces:
  `system-architecture.md` and `007-server-boundary-contract.md`.
- Normalize roadmap status vocabulary.
- Decide whether the current pause is a suitable switch-gear point where `g01`
  closes and `g02` starts. Large generations are fine; rollover should happen
  only when the development mode changes.
- Maintain `architecture/architecture-gap-index.md`.
- Maintain `architecture/implementation-gap-index.md`.
- Decide the first real product workflow to prove.

Exit criteria:

- one approved next generation theme
- no ambiguous active implementation lane
- roadmap front door points at the approved next phase

## Phase 1: Core Orchestration Model

Goal: define and implement the central work/event spine.

Work:

- Decide whether Nucleus uses event-sourced orchestration as the core model.
- Define project, task, session, thread, turn, message, activity, checkpoint,
  and runtime receipt relationships.
- Add a Rust orchestration crate or split server internals so the engine owns
  commands, events, projections, and replay.
- Define durable event identity and projection rebuild rules.
- Define how tasks map to agent work units and conversation threads.

Exit criteria:

- durable orchestration contract
- first Rust command/event/projection implementation
- tests proving deterministic projection and replay

Current roadmap coverage:

- `g02/001-orchestration-and-engine-boundary.md`
- `g02/002-event-store-persistence-hardening.md`
- `g02/003-engine-task-command-boundary.md`
- `g02/004-task-timeline-and-history-projection.md`
- `g02/005-runtime-receipts-and-effect-reactors.md`
- `g02/006-checkpoint-and-diff-foundation.md`
- `g02/012-health-and-authority-surface-reset.md`

## Phase 2: Project Management Persistence And Projection

Goal: make Nucleus project state portable and committable where policy allows.

Work:

- Define repo-backed management projection files.
- Implement import/export for project, tasks, planning artifacts, accepted
  memories, and accepted research synthesis.
- Add conflict detection and steward-assisted sync policy.
- Keep live runtime state, secrets, local caches, and provider state out of the
  projection by default.
- Support adapter-based SCM terminology, not Git-only terms.

Exit criteria:

- one project can persist management state in a repo
- another clone can import that state
- conflicts are detected and surfaced without silent overwrite

Current roadmap coverage:

- `g02/007-management-projection-sync-foundation.md`
- `g02/016-management-projection-file-io-and-sync.md`
- `g02/037-repo-backed-management-sync-hardening.md`
- `g02/038-management-sync-apply-and-review.md`
- `g02/039-scm-management-capture-and-share-foundation.md`

## Phase 3: SCM And Forge Workflow Engine

Goal: support real branch/worktree/change-request workflows.

Work:

- Implement SCM adapter registry and at least one Git adapter.
- Implement forge provider discovery and at least GitHub support.
- Implement branch/session modes:
  primary tree temporary branch and per-thread worktree branch.
- Define change request creation and review workflows.
- Model non-Git SCMs through adapter capabilities, snapshots, publication, and
  provider-specific terminology.

Exit criteria:

- Nucleus can inspect repo status, create/switch branches, create worktrees,
  and prepare a change request through policy-gated host APIs.

Current roadmap coverage:

- `g02/008-scm-forge-driver-runway.md`
- `g02/017-scm-working-copy-and-change-request-workflows.md`
- `g02/039-scm-management-capture-and-share-foundation.md`
- `g02/040-git-management-capture-adapter-proof.md`
- `g02/041-scm-working-session-execution-prep.md`
- `g02/042-change-request-preparation-boundary.md`
- `g02/043-steward-scm-sync-automation-gate.md`
- `g02/044-scm-workflow-closeout-and-next-phase-selection.md`

Current result:

- Phase 3 is complete as a record, policy, descriptor, and diagnostics runway.
- Provider-executing SCM and forge behavior remains a later runtime lane.

## Phase 3b: Code Health Gate

Goal: clear red god-file pressure before expanding runtime behavior.

Work:

- Split current error-sized test and implementation files.
- Preserve public behavior and re-exports.
- Keep validation scoped by crate.
- Rebaseline `effigy doctor` after the splits.

Exit criteria:

- current god-file error findings are cleared or explicit blockers are logged
- `cargo check --workspace` passes
- docs and roadmap front doors point at the next runtime lane

Current roadmap coverage:

- `g02/045-god-file-health-gate-rebaseline.md`
- `g02/046-management-projection-state-test-split.md`
- `g02/047-scm-work-sessions-module-split.md`
- `g02/048-diagnostics-read-model-test-split.md`
- `g02/049-engine-management-sync-test-split.md`
- `g02/050-management-projection-apply-import-split.md`
- `g02/051-change-request-prep-module-split.md`
- `g02/052-health-reset-validation-and-next-runtime-lane.md`

Current result:

- the red god-file gate is clear
- 38 warning-sized files remain as pressure when touched
- behavior was preserved through mechanical module/test splits

## Phase 4: Harness Runtime Foundation

Goal: run useful agent sessions through stable runtime boundaries.

Work:

- Pick first real harness target.
- Implement provider runtime ingestion, command reactor, cancellation,
  permission request, message identity, and session recovery surfaces.
- Keep provider capability differences explicit.
- Add canonical event logging and runtime receipts.
- Decide how Nucleus-native harness personas fit beside bridged harnesses.

Exit criteria:

- one real provider can run an agent thread through Nucleus-owned session,
  event, and projection surfaces
- failure/restart behavior is explicit

Current roadmap coverage:

- `g02/009-harness-runtime-target-selection.md`
- `g02/011-codex-app-server-runtime-runway.md`
- `g02/014-codex-live-runtime-supervision.md`
- `g02/053-harness-runtime-rebaseline.md`
- `g02/054-codex-live-event-acceptance.md`
- `g02/055-codex-process-and-transport-acceptance.md`
- `g02/056-codex-live-spawn-smoke-gate.md`

## Phase 5: Native Harness And Steward

Goal: make the Nucleus-owned steward useful.

Work:

- Define steward authority over tasks, planning, SCM sync, and project hygiene.
- Add local/small-model backend support if viable.
- Add Effigy tool knowledge and selector-routing support.
- Add memory write proposals and review flows.
- Keep autonomous actions bounded by host policy.

Exit criteria:

- steward can propose and perform limited project-organization work with
  evidence and review

Current roadmap coverage:

- `g02/018-steward-native-harness-and-effigy-tools.md`

## Phase 6: Client Protocol And Multi-Host Transport

Goal: move beyond embedded proof UI.

Work:

- Define stable client protocol versioning.
- Add local socket or HTTP/WebSocket transport.
- Add pairing/auth posture beyond local-only proof mode.
- Add host authority maps to client-visible state.
- Support multiple host connections in the client.

Exit criteria:

- desktop can connect to an embedded host or sidecar host through the same
  durable protocol
- clients can show which host owns which authority domains

Current roadmap coverage:

- `g02/010-client-protocol-and-host-transport-runway.md`
- `g02/013-host-authority-map-and-client-protocol-records.md`

## Phase 7: Workspace Panels

Goal: expose real project work surfaces.

Work:

- Adopt or recreate Loophole's display/window/surface hosting model before
  serious panel implementation, but adapt it for Nucleus' multi-project model:
  global display/window/surface config, per-project panel rules.
- Terminal panels.
- Browser/preview panels.
- Text/code editor panel with language-service boundary.
- SCM diff and commit panel.
- Runtime diagnostics, command timeline, artifact metadata, and approvals.
- Local client layout persistence: global shell config plus per-project panel
  rules.

Exit criteria:

- a user can work inside a project workspace without leaving Nucleus for basic
  inspect/edit/run/review loops
- desktop workspace state can adapt across multiple displays, multiple
  windows, and multiple hosted surfaces without making the renderer the layout
  authority
- panel arrangement state stays out of committable project-management files by
  default
- project switching can reuse the same global shell while applying the active
  project's panel rules

Current roadmap coverage:

- none in active implementation; workspace panel work remains gated behind
  host/client protocol and product workflow proof

## Phase 8: Planning, Research, Memory, And Effigy Integration

Goal: make Nucleus a project-management environment, not just a harness shell.

Work:

- Scaffold and implement planning, research, memory, and Effigy integration
  crates.
- Add guided planning sessions.
- Add deep research runs with source provenance and synthesis.
- Add memory proposals, review, scope, sensitivity, and retention.
- Add Effigy task discovery, health summaries, validation planning, and
  steward tooling.

Exit criteria:

- a new project can be planned, researched, tasked, validated, and maintained
  through Nucleus-owned flows

Current roadmap coverage:

- `g02/018-steward-native-harness-and-effigy-tools.md`

## Phase 8a: Product Workflow Proof

Goal: prove the first end-to-end Nucleus workflow before expanding UI panels
or broad automation.

Work:

- Link tasks to work items.
- Delegate one bounded unit of agentic work.
- Preserve provider session refs, runtime receipts, checkpoints, validation,
  and operator acceptance separately.
- Rebuild task timeline state from events.

Exit criteria:

- one task-backed work item can move through delegation, runtime progress,
  review, and acceptance without clients becoming state authorities

Current roadmap coverage:

- `g02/015-task-backed-agent-work-unit-proof.md`

## Phase 9: Product Hardening

Goal: prepare for sustained use.

Work:

- Observability.
- Diagnostics.
- Migrations.
- Backups and repair flows.
- Performance budgets.
- Plugin boundaries.
- Release/update channels.
- Security review.

Exit criteria:

- Nucleus can be used for real projects without relying on proof-only paths

## Open Decisions

- Which first real harness target should prove the adapter system?
- Should the first SCM implementation focus on GitHub/Git or include
  Convergence from the start as an adapter-shape test?
- How much of T3's remote/auth/relay design should influence Nucleus?
- Which workflow best proves Nucleus's project-management differentiation?

Resolved decisions:

- Event-sourced orchestration is the core model.
- `nucleus-engine` and `nucleus-orchestration` exist as the portable engine and
  orchestration boundaries.
- `nucleusd` remains a host wrapper, not the system core.
- Codex is the first bridged runtime target for task-backed agent work.
