# 2026-06-17 Stocktake

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Assess whether Nucleus is ready to continue implementation, or whether the
planning base needs tightening first.

Starting posture: strict-paused.

Reason: the repo has a broad Northstar spine and a working proof control
surface, but the active queue had become too tactical. More implementation
would risk making architecture decisions by accident.

## Documentation State

Strong coverage exists for:

- product vision
- engine-first host authority
- harness adapter contract
- model routing
- project identity
- task records
- workspace layout
- storage and persistence
- SCM/forge sync
- native harness and steward runtime
- shared memory
- structured planning
- deep research
- Effigy project integration
- local command policy and runtime readiness

The docs are comprehensive, but uneven.

Main strengths:

- Major intended domains have named contracts.
- Research was promoted into architecture and contracts for harnesses, SCM,
  native harness, planning, research, and Effigy.
- The engine-first correction is captured.
- SCM is adapter-based and no longer assumes Git as the only possible model.
- Desktop is framed as a proof client, not system authority.
- Runtime readiness and command diagnostics are separated.

Main risks:

- `docs/contracts/007-server-boundary-contract.md` is too large and now mixes
  server boundary, host authority, command execution, runtime effects,
  credentials, artifact policy, diagnostics, and local backend readiness.
- `docs/architecture/system-architecture.md` is also large and carries several
  layers of historical decisions. It is useful, but hard to use as a planning
  control surface.
- `docs/logs/README.md` had no actual decision logs before this stocktake.
- `docs/roadmaps/g01` is large. That is acceptable for a generation, but the
  front door needs to stay navigable and the next switch-gear point should be
  chosen intentionally rather than by card churn.
- Status vocabulary is inconsistent across roadmaps and cards: `done`,
  `completed`, `complete`, `completed-first-pass`, and related states all
  appear.
- The docs describe several future crates that are not scaffolded:
  `nucleus-memory`, `nucleus-planning`, `nucleus-research`, and
  `nucleus-effigy-integration`.
- Current docs are strong on contracts, weaker on product workflows and
  end-to-end user journeys.

## T3 Code Comparison

Local specimen: `external/t3code`.

Relevant T3 surfaces inspected:

- `external/t3code/docs/architecture/providers.md`
- `external/t3code/docs/architecture/runtime-modes.md`
- `external/t3code/docs/reference/workspace-layout.md`
- `external/t3code/docs/integrations/source-control-providers.md`
- `external/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/ProviderService.ts`
- `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `external/t3code/apps/server/src/orchestration/decider.ts`
- `external/t3code/apps/server/src/orchestration/projector.ts`
- `external/t3code/apps/server/src/git/GitManager.ts`
- `external/t3code/apps/server/src/git/GitWorkflowService.ts`
- `external/t3code/apps/server/src/sourceControl/SourceControlProvider.ts`
- `external/t3code/apps/server/src/sourceControl/SourceControlProviderRegistry.ts`
- `external/t3code/packages/contracts/src/git.ts`
- `external/t3code/packages/contracts/src/sourceControl.ts`

T3 has implementation depth that Nucleus docs only partially capture:

- event-sourced orchestration with commands, events, read models, decider, and
  projector
- thread-centric session lifecycle
- provider runtime ingestion and command reactors
- durable provider session runtime records
- checkpointing and turn diffs backed by Git
- worktree creation/removal and branch preparation flows
- source-control providers for GitHub, GitLab, Bitbucket, and Azure DevOps
- provider instance registry and hot-reloadable provider instances
- WebSocket request/response plus push-event transport
- process diagnostics and resource monitoring
- remote access, auth, pairing, relay, and observability surfaces
- preview automation and MCP session brokering
- schema-first TypeScript contracts at every IPC/RPC boundary

Where Nucleus intentionally differs:

- Nucleus should be Rust-first and engine-first.
- Nucleus should not make a single repo equal a project.
- Nucleus should not assume Git is the only SCM model.
- Nucleus should support embedded local, sidecar, remote worker, and remote
  authoritative host forms.
- Nucleus should treat tasks, planning, shared memory, and research as primary
  project-management domains, not bolt-ons.
- Nucleus should support bridged harnesses and a Nucleus-owned native harness.

Where Nucleus may be missing or under-specified:

- A first-class orchestration/event/projection contract equivalent to T3's
  decider/projector model.
- Thread/turn/message/activity/checkpoint semantics as a coherent workflow
  model. Nucleus has task and agent-session contracts, but not yet a complete
  conversation timeline contract.
- Provider runtime ingestion, provider command reactor, and checkpoint reactor
  equivalents.
- Durable runtime receipt and progress event semantics for long-running work.
- Source-control provider discovery/auth UX at the level T3 already has.
- Worktree and branch workflows as user-facing project/session choices, not
  only SCM adapter vocabulary.
- Remote access and pairing details beyond first-pass host/client auth.
- Observability and diagnostics as a first-class system concern.
- Preview/browser automation and MCP/session brokering as product features.
- Schema/protocol compatibility policy for clients over time.

## Implementation State

Current implementation has:

- Rust workspace with 14 packages.
- Local SQLite-backed generic state store.
- Project/task storage codecs and seeded local records.
- Transport-neutral control request/response vocabulary.
- Tauri IPC-shaped control envelope DTOs.
- Desktop proof shell with project, task, task detail, command diagnostics,
  runtime readiness, and control diagnostics panels.
- `nucleusd` CLI proof commands and read-only command runner smoke paths.
- Command policy, sandbox, process supervision, artifact metadata, event
  transport, and local process-control readiness types.
- First bounded read-only local spawn path.
- Sanitized command evidence persistence and query.
- SCM/forge, native harness, adapter registry, and agent protocol type
  surfaces.

Current implementation gaps:

- No real harness/provider adapter implementation.
- No conversation timeline runtime.
- No event-sourced orchestration store for project/task/thread/session work.
- No live subscription transport.
- No WebSocket/local socket/remote host transport.
- No real auth, pairing, credential store, or secret backend.
- No real SCM/forge adapters.
- No project management projection files.
- No shared memory, planning, deep research, or Effigy integration crates.
- No plugin system.
- No terminal, browser, editor, diff, or SCM panel runtime.
- No migration system beyond the first SQLite shape.
- No stable public client protocol beyond first control DTOs.
- No observability layer.

Implementation health issues:

- `effigy doctor` fails on `scan.god-files`.
- One high god-file exists: `crates/nucleus-command-policy/src/storage_codec.rs`.
- Many warning-sized files are accumulating in storage codecs, DTO response
  code, desktop Tauri lib, desktop global CSS, command/control DTOs, and server
  request handling.
- Current proof UI depends on Tauri IPC. Plain Vite preview renders but cannot
  call `invoke`, so browser preview is useful for layout only.
- The repo has a large uncommitted working set from the recent diagnostics
  tranche.

## Course Correction

Stop adding short implementation lanes until the long-term plan is reviewed.

The next planning work should:

- normalize roadmap navigation and status vocabulary
- decide whether this pause is a suitable switch-gear point for a new
  generation after docs and code are brought up to par
- use `docs/architecture/architecture-gap-index.md` and
  `docs/architecture/implementation-gap-index.md` to identify which contracts
  must be split or promoted
- decide whether Nucleus should adopt an event-sourced orchestration core
- decide the first real provider/harness target
- decide the first real SCM/worktree workflow target
- decide the first product workflow slice that proves Nucleus is more than a
  T3-style harness shell
