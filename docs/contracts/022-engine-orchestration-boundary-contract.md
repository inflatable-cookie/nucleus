# 022 Engine Orchestration Boundary Contract

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Define the Rust crate boundary between portable engine logic, orchestration
mechanics, and host/server wrappers.

Nucleus needs both:

- a portable engine that can run embedded, sidecar, or remote
- an orchestration core that owns event-sourced command/event/projection rules

`nucleus-server` remains useful, but it must not become the engine by accident.

## Boundary Decision

Add both crates:

- `nucleus-orchestration`
- `nucleus-engine`

`nucleus-orchestration` owns the event-sourced mechanics.

`nucleus-engine` owns host-independent domain execution and composes domain
crates, orchestration, storage repository traits, command policy, and effect
ports.

`nucleus-server` owns host API, transport, deployment, and local/remote host
wrapping.

## `nucleus-orchestration`

Responsibilities:

- command envelope traits and ids
- event envelope traits and ids
- event-store envelope and repository traits
- stream and sequence vocabulary
- projection cursor vocabulary
- replay contracts
- command decision result vocabulary
- effect intent and receipt linkage vocabulary
- deterministic projection interfaces
- test fixtures for replay and projection conformance

Non-responsibilities:

- provider SDK integration
- process spawning
- Tauri IPC
- network transport
- database-specific storage
- desktop DTOs
- SCM implementation
- project/task business rules beyond generic orchestration hooks

## `nucleus-engine`

Responsibilities:

- project authority checks
- task command handling
- project command handling
- session command admission
- workspace command admission
- command policy integration
- domain repository traits
- orchestration command dispatch
- projection rebuild coordination
- effect port definitions
- host-independent application services
- deterministic fixture execution for core workflows

Non-responsibilities:

- concrete HTTP/WebSocket/local socket transport
- Tauri command handlers
- CLI argument parsing
- OS process supervision implementation
- OS sandbox implementation
- provider process lifecycle implementation
- concrete SQLite/Postgres adapters
- UI DTO layout choices

## `nucleus-server`

Responsibilities:

- host API surface
- sidecar or remote daemon wrapper
- local transport fixtures
- HTTP/WebSocket/local socket adapters later
- client auth and pairing host boundary later
- deployment profile handling
- host capability reporting
- host runtime backend wiring
- concrete local command runner wiring
- Tauri IPC boundary only when used as host API adapter
- server/client DTO serialization at host boundary

Non-responsibilities:

- canonical task/project/session business rules
- canonical command/event/projection decisions
- replay semantics
- provider-neutral timeline identity
- host-independent effect admission
- projection rebuild logic

## Existing Module Disposition

Initial disposition for current `nucleus-server` modules:

Move toward `nucleus-orchestration`:

- `event_replay`
- event-store repository traits
- `events`
- `runtime_effect_events`
- `runtime_effect_replay`
- `runtime_effect_retention`
- `runtime_effect_storage`
- `runtime_effect_subscriptions`
- `runtime_effect_transport`
- parts of `scheduler`

Move toward `nucleus-engine`:

- `authority`
- `commands`
- `host_authority`
- `command_runtime_readiness`
- `read_only_command_control`
- `request_handler`
- `runtime_readiness_diagnostics`
- `state`
- domain seed logic only if kept as engine fixtures

Remain in `nucleus-server`:

- `clients`
- `client_auth`
- `deployment`
- `control_api` until a client protocol crate exists
- `control_envelope_dto`
- `control_serialization_readiness`
- `local_transport`
- `tauri_ipc_command`
- `tauri_ipc_readiness`
- `transport_readiness`
- concrete local backend wiring
- concrete local spawn wiring
- process supervision implementation

Move toward host runtime crates later:

- `artifact_store_backend`
- `local_artifact_store_backend`
- `local_command_runner`
- `local_event_transport_backend`
- `local_host_runtime_discovery`
- `local_process_control_backend`
- `local_read_only_spawn`
- `local_sandbox_backend`
- `process_control_backend`
- `process_event_transport_backend`
- `process_interruption`
- `process_supervision_events`
- `process_supervisor`
- `sandbox_backend`
- `secret_store`
- `server_read_only_spawn`

The first implementation tranche should not move everything. It should create
the crate boundary and migrate one narrow project/task read or command path.

## Dependency Direction

Allowed direction:

- domain crates depend on `nucleus-core` only where possible
- `nucleus-orchestration` depends on `nucleus-core`
- `nucleus-engine` depends on domain crates, `nucleus-command-policy`,
  `nucleus-orchestration`, and storage repository traits
- `nucleus-server` depends on `nucleus-engine` and host/runtime adapters
- apps depend on `nucleus-server` or embedded engine adapters

Forbidden direction:

- `nucleus-engine` must not depend on Tauri
- `nucleus-engine` must not depend on `nucleus-server`
- `nucleus-orchestration` must not depend on provider adapters
- domain crates must not depend on host/server crates
- UI code must not own durable state transitions

## Migration Rule

Migration should be incremental:

1. create empty crate fronts with module docs
2. define minimal orchestration envelopes and projection traits
3. define engine service boundary over existing project/task records
4. route one existing read path through engine
5. route one simple command admission path through orchestration
6. only then migrate provider runtime, SCM, or workspace behavior

## Health Rule

Before broad migration, clear the current high `effigy doctor` god-file finding
or keep it explicitly marked as a blocker.

Warning-sized files should be split when touched, but they do not all block
the first engine/orchestration scaffold.
