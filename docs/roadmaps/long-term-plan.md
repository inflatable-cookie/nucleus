# Long Term Plan

Status: proposed
Owner: Tom
Updated: 2026-06-17

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

G02 is the orchestration and engine-core generation. The current runway is:

1. `012-health-and-authority-surface-reset.md` - completed
2. `010-client-protocol-and-host-transport-runway.md` - completed
3. `013-host-authority-map-and-client-protocol-records.md` - completed
4. `014-codex-live-runtime-supervision.md` - active
5. `015-task-backed-agent-work-unit-proof.md`
6. `016-management-projection-file-io-and-sync.md`
7. `017-scm-working-copy-and-change-request-workflows.md`
8. `018-steward-native-harness-and-effigy-tools.md`

Only `014` is active. Later milestones are planned and should not receive
batch cards until the predecessor gate is clear.

This order intentionally pulls client protocol and authority-map records ahead
of live provider work so embedded, sidecar, and remote host behavior share the
same vocabulary before runtime supervision expands.

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
