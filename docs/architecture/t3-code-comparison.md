# T3 Code Comparison

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Compare Nucleus planning against the local T3 Code specimen.

T3 Code is not the target architecture. It is evidence for solved problems,
implementation depth, and hidden workflow details Nucleus must account for.

Local specimen: `external/t3code`.

## Specimen Caveat

T3 Code docs and code do not perfectly match.

Example: `external/t3code/docs/architecture/providers.md` says Codex is the
only implemented provider, while the source includes Claude, Codex, Cursor,
Grok, OpenCode, ACP runtime, provider instance registry, and source-control
provider implementations.

Treat source as stronger evidence than stale specimen docs.

## High-Level Shape

T3 Code is a TypeScript/Electron/WebSocket product with:

- web UI
- desktop shell
- server process
- shared schema contracts
- provider adapters
- orchestration event store
- projection read models
- checkpointing
- Git and source-control workflows
- remote access and auth surfaces

Nucleus is planned as a Rust-first, engine-first system with:

- embeddable engine
- sidecar or remote hosts
- Tauri desktop first control plane
- project-management domains as first-class surfaces
- bridged harnesses and native harness personas
- adapter-based SCM/forge model

## T3 Systems Worth Learning From

### Orchestration

T3 has command/event/projection structure:

- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Schemas.ts`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`

Important ideas:

- commands validate against current read model
- events are appended with sequence and identity
- projections are rebuilt by applying events
- reactors connect provider runtime and checkpointing to orchestration

Nucleus gap:

- no equivalent orchestration contract exists yet
- current state service is record-oriented, not event-sourced
- task/session/thread relationships are not yet unified

### Provider Runtime

T3 provider surfaces include:

- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`

Important ideas:

- adapters expose capabilities
- provider service routes through provider instance registry
- session runtime events are canonicalized
- provider sessions have durable runtime bindings
- runtime streams feed orchestration, not UI directly
- ACP support includes terminal, permission, file, elicitation, session mode,
  config option, model, and cancellation handlers

Nucleus gap:

- adapter contracts are strong, but no runtime ingestion or provider command
  reactor exists
- provider instance hot reload and per-instance configuration are not yet
  deeply planned
- ACP client callback surfaces are under-specified compared with T3 source

### Git, Worktrees, And Source Control

T3 source-control surfaces include:

- `apps/server/src/git/GitManager.ts`
- `apps/server/src/git/GitWorkflowService.ts`
- `apps/server/src/sourceControl/SourceControlProvider.ts`
- `apps/server/src/sourceControl/SourceControlProviderRegistry.ts`
- `packages/contracts/src/git.ts`
- `packages/contracts/src/sourceControl.ts`

Important ideas:

- Git workflow service routes through a VCS driver registry
- source-control provider registry resolves provider context from remotes
- provider discovery reports CLI availability and auth status
- branch/worktree flows are explicit IPC surfaces
- stacked actions combine branch, commit, push, and change request creation
- change request terminology is provider-dependent

Nucleus gap:

- Nucleus has stronger non-Git SCM posture, but no implemented SCM driver
  registry
- source-control provider discovery/auth UX is not yet detailed enough
- worktree modes are planned but not yet tied to session/task orchestration
- commit/push/change-request progress events are not yet modeled

### Checkpoints And Diffs

T3 surfaces include:

- `apps/server/src/checkpointing/Layers/CheckpointStore.ts`
- `apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`

Important ideas:

- turns can have checkpoints
- diffs become projected thread summaries
- revert is a workflow, not a raw Git operation

Nucleus gap:

- command evidence exists, but task/session checkpoint semantics are not
  planned as a coherent model
- SCM worktree planning does not yet define checkpoint ownership

### Remote Access, Auth, And Relay

T3 has:

- environment auth
- pairing grants
- server secrets
- session store
- DPoP helpers
- relay auth/client/shared packages
- managed endpoint runtime

Nucleus gap:

- host/client auth exists as readiness vocabulary only
- no concrete pairing, revocation, session, token, relay, or managed host
  protocol exists
- multi-host authority maps need transport and auth detail before remote work

### Preview Automation And MCP

T3 has:

- MCP server/session registry
- preview automation broker
- browser preview tooling
- provider-session MCP credentials

Nucleus gap:

- browser panels are planned, but preview automation and MCP brokering are not
  yet first-class contracts
- native/bridged harness tool access needs a concrete broker model

### Observability

T3 has:

- process diagnostics
- process resource monitor
- trace diagnostics
- metrics and RPC instrumentation
- relay observability docs

Nucleus gap:

- diagnostics panels exist, but there is no observability contract or runtime
  metrics architecture

## Nucleus Intentional Divergences

- project is durable and may span repos
- task/planning/memory/research are core domains
- SCM is adapter-based and not Git-only
- server is a host form, not the system core
- desktop may embed the engine
- native harness personas are planned alongside bridged providers
- repo-backed project management projection is a first-class goal

## Architecture Gaps To Promote

Promote these into contracts before more implementation:

- orchestration/event/projection contract
- conversation timeline contract
- runtime receipt and progress event contract
- checkpoint and diff ownership contract
- SCM driver and source-control provider discovery contract split
- remote host pairing/session contract
- preview automation and MCP tool broker contract

## Materialisation Assessment

Status: active planning correction
Updated: 2026-06-19

The comparison has been promoted far enough to guide early Codex runtime
records, but not far enough to shape the runtime service layer. The current
Nucleus implementation is still lower-level than T3 Code: it models request,
admission, envelope, outcome, receipt, and diagnostics records before it has a
provider service that owns runtime sessions and streams.

This is useful as boundary proof, but it becomes churn if it continues without
service integration.

### T3 Lessons Not Yet Materialised

Provider service ownership:

- T3 has a `ProviderService` surface that routes through adapter and provider
  instance registries.
- Nucleus has provider identities and Codex record gates, but no service that
  owns provider instances, session runtimes, command routing, stream lifecycle,
  or recovery policy.

Provider instance registry:

- T3 separates driver kind from provider instance configuration.
- Nucleus needs a runtime registry with instance config, capability discovery,
  auth readiness, hot reload posture, and process ownership before more
  provider commands are added.

Command, event, projection, and reactor loop:

- T3 connects provider runtime events to orchestration events, projections, and
  checkpoint reactors.
- Nucleus has records and read models, but the current Codex path is not yet a
  full command/event/projection/reactor loop.

Runtime event streams:

- T3 treats provider sessions as streaming runtimes.
- Nucleus has live frame ingestion and receipts, but not a long-lived service
  that continuously decodes provider events, applies idempotency, persists
  projections, and publishes client-visible state.

Checkpoint, diff, and worktree coupling:

- T3 makes turns, checkpoints, diffs, and source-control actions part of the
  same workflow.
- Nucleus has stronger SCM neutrality, but Codex turns, task work units,
  checkpoints, and SCM work sessions are not yet integrated as one execution
  path.

Control-plane query routing:

- T3 exposes runtime state through client-facing projections.
- Nucleus has some diagnostics DTOs that are modeled and exported before all of
  them are routed through the control API.

Remote access and auth:

- T3 has concrete pairing, auth, relay, endpoint, and session surfaces.
- Nucleus has authority and readiness vocabulary, but not the actual host
  pairing/session/revocation protocol.

ACP callback details:

- T3's Cursor/OpenCode/ACP surfaces include practical callback, elicitation,
  cancellation, terminal, file, and session-mode handling.
- Nucleus should inspect those paths before implementing non-Codex adapters.

Observability:

- T3 has trace, process, metric, and relay diagnostics.
- Nucleus has read-model diagnostics, but not a runtime observability contract
  covering metrics, traces, support bundles, or resource monitors.

Test and module structure:

- T3's runtime structure keeps adapter/service boundaries visible.
- Nucleus Codex supervision has started duplicating fixture setup across small
  record modules. This creates god-file pressure and makes later service
  integration harder.

### Corrective Direction

Do not keep widening provider record gates in isolation.

The next provider-runtime tranche should:

- extract shared Codex supervision fixtures and reduce oversized modules
- route new diagnostics through the control API before adding more UI-visible
  state
- introduce a provider-service/runtime skeleton shaped by T3's adapter service
  model
- add provider instance registry/config records before more provider commands
- connect provider outcomes into orchestration events and projections
- bind Codex turns, checkpoints, diffs, task work units, and SCM work sessions
  through one execution workflow

Intentional divergence remains intact: Nucleus is Rust-first, project-first,
task-first, SCM-adapter-neutral, and engine-first. T3 is a specimen, not a
target architecture.
- observability and diagnostics contract
