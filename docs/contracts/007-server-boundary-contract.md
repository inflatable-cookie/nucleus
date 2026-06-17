# 007 Server Boundary Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the server/host API boundary that control planes use.

The server is one Nucleus host form, not the system core. The portable Rust
engine is the core authority implementation surface. Desktop, web, mobile,
CLI, and service clients are control planes over authoritative engine hosts.

This contract keeps the historical `server` name for current crate and API
surfaces, but new architecture should read it as host API unless a section is
specifically about `nucleusd` as a daemon.

## Focused Authority Owners

This contract is the server/host API boundary. It no longer owns every durable
Nucleus rule.

When this file overlaps a focused contract, the focused contract owns the
durable rule and this file owns only host exposure, access, transport, DTO, or
runtime wrapper details.

Canonical owners:

- `017-engine-host-authority-contract.md`: engine host forms, authority maps,
  project authority assignment, and multi-host rules
- `018-orchestration-contract.md`: command, event, projection, replay, and
  orchestration effect spine
- `019-conversation-timeline-contract.md`: task, work item, session, thread,
  turn, message, activity, and provider-id mapping
- `020-runtime-receipt-contract.md`: durable runtime receipts, progress events,
  side-effect evidence, and receipt projection
- `021-checkpoint-diff-contract.md`: checkpoint, diff, review snapshot, and
  task/turn linkage
- `022-engine-orchestration-boundary-contract.md`: portable engine,
  orchestration crate, host/server crate, and effect-port ownership
- `011-scm-forge-sync-contract.md`: SCM, forge, work-session, branch,
  worktree, change-request, publication, and review workflow rules
- `008-storage-state-persistence-contract.md`: storage domains, record
  identity, repository traits, backend adapters, revisions, and journals
- `002-harness-adapter-contract.md`: harness adapter identity, transports,
  capability discovery, provider event identity, and adapter recovery

Remaining server-boundary ownership until a focused contract supersedes it:

- client auth, pairing, revocation, and access endpoint surfaces
- server control API command/query DTOs and transport-safe envelopes
- local command execution, sandbox, artifact, process supervision, and host
  spawn readiness wrapper rules
- secret material resolution as a host runtime boundary
- runtime diagnostics and local proof surfaces

## Host Authority Rule

Host connection does not imply project authority.

An engine host owns only the authority domains assigned to it by a project
authority map. Initial authority domains:

- project records
- source checkout and worktree state
- repo membership and path history
- task records
- agent session records
- workspace layouts
- terminal attachment state
- browser attachment state
- harness process lifecycle
- model routes
- shared memory records
- planning records
- research records
- SCM/forge actions
- command execution
- credentials
- audit/evidence records
- projection records

Clients may cache and render state, but must reconcile with the authoritative
host for the affected domain.

Tauri may embed the engine and act as the authoritative local host for
single-user local workflows. Tauri UI code must not become authority by
itself; authority remains in Rust engine/host APIs.

`nucleusd` may act as a local sidecar host, remote authoritative host, remote
worker/proxy host, or managed team host depending on deployment and project
authority map.

## Deployment Boundary

A deployment has:

- one running engine host
- one deployment mode
- one or more access endpoints
- one or more clients connected through those endpoints

Initial deployment modes:

- embedded local
- local-only
- local sidecar
- local network
- internet reachable
- remote worker/proxy
- remote authoritative
- managed remote

Access transport is not fixed yet. The contract must support local socket,
loopback HTTP, LAN HTTP, remote HTTP, and custom endpoints without treating any
client as the runtime owner.

## Client Boundary

Clients must identify:

- stable client id
- client kind
- display name
- access endpoint
- connection state

Initial client kinds:

- desktop
- web
- mobile
- CLI
- service

## Client Protocol Boundary

The client protocol names the message envelope shape shared by embedded,
sidecar, local, and future remote clients.

The first profile is `nucleus.client` v1 and is exact-version only until an
upgrade contract exists.

Initial protocol message kinds:

- control request
- control response
- server event

Protocol records are boundary records. They do not grant project authority,
replace engine host authority, choose a transport, implement subscriptions,
authenticate clients, or own durable state.

DTOs remain transport-safe payload shapes. Durable command, query, event,
receipt, timeline, checkpoint, and authority rules stay in the focused
contracts listed above.

Server event envelopes may name replay tokens so clients can request catch-up,
but replay authority belongs to the orchestration and event-replay surfaces,
not to the client renderer.

## Host Capability Advertisement Boundary

Hosts may advertise client-visible capabilities through the client protocol.

Initial advertised surfaces:

- host identity and host form
- connection mode: embedded, local sidecar, remote authoritative, remote
  worker, managed, or custom
- supported client protocol profile
- control request, state query, event replay, runtime readiness, command
  scheduling, harness runtime, SCM/forge, and management projection capability
  categories
- authority-map publication posture
- runtime readiness publication posture

Advertisement records do not grant authority. They tell clients what a host
claims it can expose and whether authority-map or runtime-readiness information
is published, deferred, or unsupported.

Authority-map mutation and durable authority assignment belong to
`017-engine-host-authority-contract.md` and the follow-on
`013-host-authority-map-and-client-protocol-records.md` roadmap. Runtime
readiness records remain evidence/read-model surfaces; they are not transport
permission and do not bypass auth, pairing, or command approval.

Client-visible authority-map publication records may expose assigned,
mutation-denied, fallback-only, unassigned, and publication-deferred domain
states. These records are explanatory read models. They do not grant authority,
persist authority maps, repair assignments, synchronize hosts, or open
transports.

## Client Auth And Pairing Boundary

Client auth is a server-owned access boundary.

It identifies which client is allowed to connect to the server. It is separate
from transport selection, event replay, runtime subscriptions, command
approval, provider credentials, model credentials, secret storage, and harness
permission prompts.

Initial auth postures:

- unpaired local
- pairing required
- login required
- managed identity required
- service credential reference required
- revoked
- custom

Initial pairing modes:

- local interactive pairing
- LAN pairing
- remote login
- managed invite
- service bootstrap
- disabled
- custom

Deployment posture:

- local-only may allow unpaired local desktop or CLI access by explicit server
  profile
- local network requires pairing before a new desktop, mobile, web, or CLI
  client can control state
- internet-reachable requires normal auth posture plus revocation and client
  identity records
- managed remote requires managed identity, invite, or service credential
  reference posture

Minimum durable client auth record:

- stable auth record id
- stable client id
- client kind
- display name
- auth posture
- pairing mode
- non-secret credential reference where needed
- revocation state

Credential material must not live in normal server state. Auth records may
store credential references and sanitized audit evidence only. A later secret
store contract must define credential material storage, rotation, and
revocation mechanics.

Revocation is server-owned. Revoking a client may close active connections,
interrupt subscriptions, require replay tokens to be discarded, and prevent new
commands from that client. Revocation must not delete historical events,
command evidence, adapter observations, task history, or audit records.

Client auth does not grant command approval. An authenticated client may still
need command approval for destructive, network, source-code write, secret
access, or process lifecycle commands. Model output still never counts as
approval.

Transport identity must not replace server-owned client identity. A transport
may present credentials or connection metadata, but the server maps that input
to a stable client identity and auth record before state authority is granted.

This boundary does not choose OAuth, passkeys, mTLS, token auth, pairing codes,
device codes, local OS keychain integration, or any other concrete mechanism.
It also does not implement auth, pairing, credential storage, secret storage,
transport, command approval, or runtime execution.

First Rust readiness gates now exist for local client auth posture. They can
allow explicit local-only unpaired access, deny unsupported client kinds or
revoked clients, and mark remote-login, managed-identity, or service-credential
postures as deferred. These gates are policy checks only. They do not create
pairing records, authenticate credentials, open transports, or grant command
approval.

Client-visible auth posture records may project readiness into allowed,
blocked, deferred, or revoked dispositions. These records are explanatory
protocol/read-model surfaces. They may carry non-secret credential references,
but never credential material. They also keep command approval and provider
credential access as separate boundaries.

## Command Boundary

Clients send commands. The server decides whether to accept, reject, queue, or
execute them.

Initial command categories:

- project commands
- task commands
- workspace commands
- agent session commands
- model route configuration

Commands must carry stable command ids so clients can reconcile retries,
duplicate submissions, and command results.

The first Rust control API vocabulary now separates control requests, commands,
queries, responses, command receipts, query results, and errors. The first
replay service skeleton can read stored event metadata and runtime effect
metadata by cursor. It does not provide live subscriptions, event fanout,
network transport, Tauri IPC, request handling, scheduling, command execution,
or provider runtime behavior.

Runtime readiness diagnostics are a read-only server query surface. They
project host readiness descriptors into client-safe records with:

- host id
- runtime surface
- readiness status
- sanitized blockers
- evidence refs
- sanitized repair hints
- summary

Readiness diagnostics do not grant command approval, execute commands, expose
artifact payloads, expose credentials, stream output, or let clients infer
that a blocked runtime can be bypassed.

The first runtime readiness query is local host command execution readiness.
It maps local host discovery descriptors for sandbox, artifact storage, event
transport, and process control into a typed control DTO. Unsupported local
runtime state remains explicit and client-renderable.

## Command Execution Authority

The server owns local command execution authority.

Clients, SCM adapters, forge adapters, harness adapters, native personas,
validation workflows, and steward workflows may request command authority. They
must not run local commands by bypassing server policy.

Initial command authority areas:

- SCM adapter
- forge adapter
- harness adapter
- native persona
- validation
- steward
- user terminal
- custom

Initial command scopes:

- read-only inspection
- management-state write
- source-code write
- network access
- destructive
- process lifecycle
- secret access
- custom

Read-only inspection may be auto-allowed by project or server policy.
Management-state writes require explicit scope checks. Source-code writes,
network-capable commands, process lifecycle commands, secret-access commands,
and destructive commands require stronger policy gates.

Destructive commands require approval every time unless a later contract
defines a narrower safe exception. Model output must never count as approval.

Command policy must include:

- authority area
- command scope
- risk
- sandbox profile
- approval policy
- working-directory hint
- sanitized command display

Initial sandbox profiles:

- host default
- project restricted
- worktree restricted
- network denied
- network allowed
- no filesystem write
- custom

The command boundary is not a shell. It is a policy-gated execution request and
evidence surface. PTY handling, terminal UI, process spawning, environment
construction, sandbox implementation, and output streaming remain
implementation details behind this boundary.

## Command Evidence

Command evidence is sanitized state.

Initial evidence statuses:

- accepted
- rejected
- queued
- running
- succeeded
- failed
- cancelled
- timed out
- blocked by policy

Command output retention modes:

- discard
- summary only
- artifact reference
- full artifact with approval

Command evidence may retain command request id, status, exit status, retention
mode, artifact refs, and short sanitized summary. It must not copy raw output
into task history, projection records, event journals, or logs by default.

## Command History Query Surface

Command history queries return sanitized command evidence DTOs, not raw storage
records.

Initial command history DTO fields:

- evidence id
- command request id
- status
- exit status
- retention mode
- sanitized summary
- stdout artifact ref
- stderr artifact ref

Command history DTOs must not expose raw stdout, raw stderr, process
transcripts, environment values, credentials, storage payload bytes, or
storage revision metadata.

Artifact refs are references only. Fetching artifact payloads requires a later
artifact resolution contract and must not be implied by the history list.

Clients may render command history from this DTO. Clients must not decode
command evidence storage records directly.

## Command Diagnostics Client Read Model

Command diagnostics clients render a read-only view over command history. The
read model maps from command evidence DTOs and does not add authority.

List rows may show:

- evidence id
- command request id
- status
- exit status
- retention mode
- one-line sanitized summary when present
- stdout artifact ref presence
- stderr artifact ref presence

Detail views may show:

- all list-row fields
- full sanitized summary
- exact stdout artifact ref string when present
- exact stderr artifact ref string when present
- raw-output availability as `not_retained`
- artifact resolution status only after a later artifact contract provides it

Empty states must distinguish:

- no command evidence exists
- command history query failed
- command history query is unsupported by the connected host
- command history is unavailable because the client is not authorized for the
  evidence domain

Refresh is pull-based for the first diagnostics surface. Clients may request
the latest command history after command submission, focus, reconnect, or user
refresh. Live subscriptions and streaming output require later event transport
contracts.

The read model must not expose:

- raw stdout
- raw stderr
- process transcripts
- environment values
- credentials
- storage payload bytes
- storage revision metadata
- shell command strings synthesized from executable and argv

Command diagnostics panels must not offer execution, cancellation, retry,
artifact download, or approval controls until those actions have explicit
server command contracts.

## Command Fixture Policy

Command policy tests need fixtures before a command runner exists.

Required first fixture profiles:

- read-only inspection request, auto-allowed, no filesystem write
- management-state write request, approval required once
- source-code write request, approval required every time
- network access request, explicit network sandbox profile
- destructive request, blocked or approval required every time
- secret access request, blocked without explicit credential policy
- command succeeded with summary-only evidence
- command failed with artifact refs
- command blocked by policy
- command timed out

Command fixtures must not spawn processes, open terminals, create shells, use
network, read host credentials, or retain raw stdout/stderr. They describe
requests, decisions, and sanitized evidence only.

Fixture builders are test-support surfaces. They should live in dev-only
modules, test support crates, or integration-test fixtures. They must not
become stable production APIs until a later contract explicitly promotes them.

The dev-only fixture boundary is the unpublished
`nucleus-contract-fixtures` crate.

The fixture crate may depend on `nucleus-command-policy` for request,
decision, approval, sandbox, and sanitized evidence vocabulary. Production
crates must not depend on the fixture crate.

The fixture crate may contain command-policy fake adapter skeletons for
contract tests. These skeletons must return deterministic request and evidence
records only. They must not execute commands, spawn processes, open terminals,
implement sandboxes, or read credentials.

The fixture crate may contain ordered command-policy scenario scripts. Scenario
scripts may prove command request and evidence ordering, but they are not the
production command event model, command runner, replay log, or persistence
schema.

## Production Command Authority Trait Boundary

The production command authority boundary belongs to the server. It is not an
adapter-local helper API.

Initial command authority trait responsibilities:

- accept command execution requests from clients, SCM adapters, forge adapters,
  harness adapters, native personas, validation workflows, steward workflows,
  and user terminals
- classify authority area, command scope, risk, sandbox profile, and approval
  policy
- return accepted, rejected, queued, blocked, running, succeeded, failed,
  cancelled, and timed-out evidence states
- retain sanitized summaries and artifact refs, not raw output by default
- keep approval state separate from model output
- keep credential references separate from credential material

The command authority boundary may expose value-returning policy inspection
first. Actual process spawning, PTY handling, sandbox implementation, output
streaming, cancellation, and artifact retention are effectful runtime
boundaries. They need a later runtime contract before Rust traits are
implemented.

SCM, forge, harness, and native persona adapters may request command authority.
They must not execute host commands directly or bypass the command policy
boundary.

Dev-only command fixtures, fake adapters, and scenario scripts are evidence for
the trait boundary. They must not be copied directly into production trait APIs.

First command-policy contract tests should prove:

- auto-allowed read-only inspection retains summary-only evidence
- management-state write requires approval once
- source-code write requires approval every time
- network access needs explicit network scope
- destructive command is blocked or approval-required every time
- secret access is blocked without explicit credential policy
- failed command evidence uses artifact refs rather than raw output
- timeout and policy-blocked states are distinct

## Event Boundary

The server emits events for clients to render or reconcile.

Initial event categories:

- project changed
- task changed
- workspace changed
- agent runtime event
- client connected
- client disconnected
- warning
- error

Events must carry stable server event ids. Adapter runtime events retain their
adapter-level event identity inside the server event.

## Task Command Mutation Boundary

Task command mutation is server authority.

The first executable subset covers activity transitions for existing task
records:

- start task
- block task with reason
- complete task
- archive task

Create and update commands now have a first server-owned path using task
authoring input.

Task mutation handling must:

- read task records through `ServerStateService`
- decode typed task storage payloads
- update only the requested activity state in the first subset
- write back through the task repository
- preserve unrelated task display fields
- return explicit not-found, conflict, malformed-payload, or unsupported errors
- keep runtime execution, validation command execution, and agent assignment out
  of the state mutation handler

Command DTOs must not expose raw storage records. Client-originated mutation
requests should include stable command id, client id, task id, intended
transition, transition-specific fields, and expected revision when available.
The server decides whether a transition is supported.

Task create/update command DTOs should use task authoring input, not display
DTOs or storage records.

Create commands should include:

- stable command id
- client id
- project id
- title
- action type
- importance
- optional description
- optional acceptance criteria
- optional initial activity state
- optional agent-readiness fields
- optional model preference refs
- optional user-authored SCM or forge links

Update commands should include:

- stable command id
- client id
- task id
- expected revision
- replacement values for editable fields

The server must own task id creation, schema version, storage revision,
timestamps, task history, assignment snapshots, adapter-observed links, runtime
refs, command evidence refs, and projection paths.

Create/update handling must validate project existence, supported action type,
importance vocabulary, allowed activity state, blocked reason requirements,
agent-readiness constraints, and reference shape before writing state.

Create/update handling must not accept raw storage payloads from clients. It
must write through server state services, then return read-after-write task
records through the typed DTO boundary.

## Current Rust Surface

`nucleus-server` now contains the first draft of:

- `ClientId`
- `ServerCommandId`
- `ServerEventId`
- `ClientIdentity`
- `ClientKind`
- `ClientConnection`
- `DeploymentMode`
- `AccessEndpoint`
- `ServerRuntime`
- `AuthorityArea`
- `ServerAuthority`
- `ServerCommand`
- `ServerCommandKind`
- `ProjectCommand`
- `TaskCommand`
- `TaskCreateCommand`
- `TaskUpdateCommand`
- `TaskUpdateChanges`
- `TaskTransitionCommand`
- `WorkspaceCommand`
- `AgentSessionCommand`
- `ServerEvent`
- `ServerEventKind`
- `RuntimeEffectStorageRecordId`
- `RuntimeEffectReplayCheckpointId`
- `RuntimeEffectStoredEventRecord`
- `RuntimeEffectStoredEventKind`
- `RuntimeEffectStorageRef`
- `RuntimeEffectReplayCheckpoint`
- `RuntimeEffectStoredEffectState`
- `RuntimeEffectStorageQuery`
- `RuntimeEffectLatestStateLookup`
- `RuntimeEffectRetryLineageRef`
- `RuntimeEffectRecoveryLookup`
- `RuntimeEffectClientOrderingToken`
- `RuntimeEffectReplayStorageGeneration`
- `RuntimeEffectReplayQueryRequest`
- `RuntimeEffectReplayQueryResponse`
- `RuntimeEffectReplayQueryStatus`
- `RuntimeEffectReplayUnsupportedReason`
- `RuntimeEffectReplayQueryResult`
- `RuntimeEffectReplayRefResolution`
- `RuntimeEffectSubscriptionId`
- `RuntimeEffectSubscriptionHandshake`
- `RuntimeEffectSubscriptionState`
- `RuntimeEffectDeliveryAcknowledgement`
- `RuntimeEffectBackpressurePosture`
- `RuntimeEffectDisconnectReason`
- `RuntimeEffectReconnectRequirement`
- `RuntimeEffectTransportFamily`
- `RuntimeEffectTransportProfile`
- `RuntimeEffectTransportCapability`
- `RuntimeEffectTransportBoundaryGuarantee`
- `RuntimeEffectTransportSelectionCriteria`
- `RuntimeEffectTransportAuthBlocker`
- `ServerCommandArtifactRecord`
- `ServerCommandArtifactResolution`
- `ServerCommandRuntimeReadiness`
- `ServerCommandRuntimeReadinessDisposition`
- `ClientAuthRecordId`
- `ClientPairingId`
- `ClientAuthSessionId`
- `ClientAuthPosture`
- `ClientPairingMode`
- `ClientAuthDeploymentPolicy`
- `ClientPairingRecord`
- `ClientAuthSessionRecord`
- `ClientRevocationRecord`

`nucleus-command-policy` now contains the first draft of:

- `CommandPolicyId`
- `CommandRequestId`
- `CommandEvidenceId`
- `CommandAuthorityReadiness`
- `CommandAuthorityPolicySurface`
- `CommandEffectRequestId`
- `CommandEffectRequest`
- `CommandEffectRequestKind`
- `CommandEffectCancellation`
- `CommandEffectRetry`
- `CommandEffectOutcome`
- `CommandEffectOutcomeKind`
- `CommandExecutionRequest`
- `CommandAuthorityArea`
- `CommandScope`
- `CommandRisk`
- `CommandSandboxProfile`
- `CommandApprovalPolicy`
- `CommandEvidence`
- `CommandExecutionStatus`
- `CommandOutputRetention`
- `CommandArtifactApprovalRequirement`
- `CommandArtifactDescriptor`
- `CommandArtifactPayloadClass`
- `CommandArtifactRedactionStatus`
- `CommandArtifactResolutionStatus`
- `CommandArtifactRetentionPolicy`
- `CommandArtifactSecretScanStatus`
- `CommandRunnerRuntimeSurface`
- `CommandRunnerReadinessGate`
- `CommandRunnerReadinessStatus`
- `CommandRunnerReadinessBlocker`
- `CommandCredentialReadinessRef`
- `CommandEnvironmentPlan`
- `CommandOutputCapturePlan`
- `CommandInterruptionPlan`
- `CommandRunnerReadinessPlan`

These are descriptive boundary types only. Networking, auth, persistence,
subscriptions, runtime routing, process spawning, sandbox implementation, PTY
handling, process lifecycle, fake command execution, and fixture builder
implementation remain out of scope.

The first Rust command authority trait skeleton exposes policy inspection only:
policy id, readiness, supported scopes, default sandbox, and approval policy.
It does not execute commands, spawn processes, stream output, retain artifacts,
open terminals, or implement sandboxes.

`nucleus-server` now contains the first local read-only command runner
skeleton:

- `LocalReadOnlyCommandRunner`
- `LocalReadOnlyCommandRunnerRejection`

`nucleus-command-policy` now contains shared structured invocation vocabulary:

- `CommandInvocation`
- `CommandEnvironmentPolicy`

The server skeleton validates the first local read-only subset and returns
sanitized queued or blocked evidence. It does not spawn processes, open shells,
stream output, retain raw stdout/stderr, enforce a real sandbox, or prove
command completion.

The first real local read-only spawn path now exists behind the server
boundary:

- `run_local_read_only_spawn`
- `ServerReadOnlySpawnInput`
- `ServerReadOnlySpawnResult`
- `run_server_read_only_spawn`
- `LocalReadOnlySpawnSmokeInput`
- `build_local_read_only_spawn_smoke_input`

The path requires a ready host-spawn gate before spawn, structured executable
and argv values, finite timeout, bounded stdout/stderr capture, and
summary-only output retention. It persists sanitized command evidence through
server state. It does not expose raw stdout/stderr, environment variables,
credentials, terminal byte streams, shell traces, PTY state, or full artifact
payloads by default.

`nucleusd command-runner read-only-spawn-smoke` is a fixed smoke command for
this path. It proves server wiring, readiness composition, process exit status,
event count, byte-count summaries, truncation reporting, and sanitized evidence
persistence. It is not a general command execution API and must not be expanded
to arbitrary client input until the read-only command request/admission control
API shape is defined.

The first read-only command control API shape is now defined for structured
client requests:

- `ReadOnlyCommand`
- `ReadOnlyCommandControlResult`
- `ReadOnlyCommandControlRejection`
- `run_read_only_command_control`
- `ControlCommandDto::ReadOnlyCommand`
- `ControlResponseBodyDto::ReadOnlyCommandResult`

Request fields are structured and bounded:

- stable command id
- project id
- execution host id
- executable
- argv list
- working directory
- timeout in milliseconds
- stdout and stderr byte limits
- optional sanitized display string

Response fields are sanitized:

- command id
- command request id
- evidence id
- execution status
- exit status
- retention mode
- sanitized summary
- stdout and stderr captured byte counts
- stdout and stderr truncation flags
- supervision event count
- sanitized rejection category

The response must not expose raw stdout, raw stderr, terminal byte streams,
shell traces, environment variables, credential material, or full artifact
payloads. Shell passthrough, invalid working directories, missing timeout, and
unbounded output are rejected before spawn. Accepted requests still pass
through host-spawn readiness, read-only runner validation, server-owned spawn
execution, and sanitized evidence persistence.

This control path is narrow enough for constrained CLI input next. Desktop UI
controls should wait until the CLI path proves structured argument handling,
operator feedback, and evidence query ergonomics.

`nucleusd` now exposes the constrained CLI syntax:

```text
nucleusd command-runner read-only [--cwd <dir>] [--timeout-ms <ms>] [--stdout-limit <bytes>] [--stderr-limit <bytes>] -- <executable> [args...]
```

Rules:

- flags must appear before `--`
- executable and argv must appear after `--`
- the CLI must not accept a single shell command string
- `--cwd` defaults to the current directory
- `--timeout-ms` defaults to `2000`
- `--stdout-limit` and `--stderr-limit` default to `16384`
- zero timeout or output limits are invalid
- shell entrypoints such as `sh`, `bash`, `zsh`, `cmd`, `powershell`, and
  `pwsh` remain blocked by the server runner before spawn
- CLI output may print status, exit status, evidence id, event count, byte
  counts, truncation flags, rejection category, and sanitized summary
- CLI output must not print raw stdout or raw stderr

The CLI path routes through `LocalControlRequestHandler` and
`ServerCommandKind::ReadOnlyCommand`; it must not call the spawn helper
directly. It is a proof path for server control semantics, not a desktop UI
contract.

Compile-focused trait tests use local test structs only. They prove the command
authority surface can inspect policy without executing commands, reading
credentials, opening terminals, streaming output, or depending on dev-only
fixtures.

## Runtime Command Effect Boundary

Command execution is an effectful server boundary.

Initial command effect categories:

- policy inspection
- approval request
- command acceptance or rejection
- queueing
- process preparation
- sandbox preparation
- process start
- output capture
- cancellation request
- timeout handling
- artifact retention
- sanitized evidence publication
- recovery after server restart or process interruption

Adapters, clients, validators, native personas, and steward workflows may
submit command authority requests. The server classifies the request, applies
policy, asks for approval when needed, prepares the sandbox, executes only when
allowed, and returns sanitized evidence.

Command effects must not expose raw stdout, stderr, environment, credentials,
or filesystem paths by default. Raw artifacts require explicit retention policy
and approval where needed.

Cancellation is cooperative at this contract level. The server records
cancellation requests and final outcomes separately. A provider, process, or
host sandbox may fail to interrupt cleanly; that must be represented as
evidence, not hidden.

Retries must be server-scheduled and policy-aware. A failed command may be
retryable, blocked by policy, missing approval, missing credential, timed out,
cancelled, or unsupported. Model output must never grant retry or approval
authority on its own.

Async runtime, PTY strategy, stream type, sandbox implementation, artifact
store, process supervisor, and replay store are unresolved. They require a
later runtime contract before command execution traits are implemented.

The first Rust command effect type skeletons name command effect request ids,
request kinds, cancellation posture, retry classification, and effect outcomes.
They do not execute commands, spawn processes, open terminals, stream output,
retain artifacts, schedule retries, or implement sandboxes.

Compile-focused command effect type tests use local values only. They prove
effect request ids stay separate from command request ids, queued and
evidence-bearing outcomes compose, cancellation posture is explicit, retry
classifications stay distinct, and sanitized evidence remains the outcome
payload instead of raw process output.

## Runtime Command Effect Trait Boundary

Runtime command effect traits should be split by responsibility.

Initial command effect responsibilities:

- accept command effect requests from the server command authority boundary
- report accepted, rejected, queued, blocked, unsupported, or approval-required
  states before execution
- prepare process and sandbox execution only after policy allows it
- publish sanitized evidence for running, succeeded, failed, cancelled,
  timed-out, and blocked-by-policy states
- keep raw stdout, stderr, environment, credentials, and filesystem paths out
  of default outcomes
- report cancellation, timeout, retry, artifact-retention, and recovery
  outcomes without hiding partial execution

Command effect acceptance and final command evidence publication may be
separate trait surfaces. Acceptance is policy and scheduling state. Evidence
publication is runtime result state. A later Rust trait draft should preserve
that split unless a narrower command runner contract proves a single surface is
enough.

Cancellation needs explicit outcome reporting. A cancellation request is not a
final state. The command runner may report cancelled, timed out,
cooperative-only, unsupported, or recovery-required outcomes after cancellation
is requested.

The server owns scheduling, retry policy, timeout policy, approval state,
credential policy, artifact-retention policy, and client event fan-out. Command
effect traits may execute only under server-issued authority and must return
sanitized evidence.

The first Rust trait draft may name value-returning acceptance and outcome
surfaces. Async runtime, PTY strategy, stream type, sandbox backend, process
supervisor, artifact store, and replay store remain deferred.

The first Rust command runtime effect trait skeletons now expose separate
request-acceptance and outcome-reporting surfaces. They are value-shaped and
compile-only. They do not execute commands, spawn processes, open terminals,
stream output, implement sandboxes, retain artifacts, schedule retries, or
persist replay state.

## Runtime Command Effect State Machine Policy

Command effects move through server-owned state. Command runners report
acceptance and sanitized evidence outcomes; they do not own scheduling, retry,
approval, artifact-retention, or event fan-out policy.

Initial non-terminal states:

- requested
- policy inspection
- approval required
- accepted
- queued
- running
- cancellation requested
- recovery required

Initial terminal states:

- rejected
- blocked by policy
- unsupported
- succeeded
- failed
- cancelled
- timed out

Allowed first transitions:

- requested to policy inspection
- requested to approval required
- requested to accepted
- requested to rejected
- requested to blocked by policy
- requested to unsupported

Allowed execution transitions:

- policy inspection to accepted, approval required, rejected, blocked by policy,
  or unsupported
- approval required to accepted, rejected, blocked by policy, or cancelled
- accepted to queued or running
- queued to running

Allowed completion transitions:

- accepted to succeeded, failed, cancelled, timed out, or recovery required
- queued to cancelled, timed out, or recovery required
- running to succeeded, failed, cancelled, timed out, or recovery required
- recovery required to queued, running, failed, cancelled, timed out, or
  unsupported

Cancellation is a request, not a terminal state. It may move from approval
required, accepted, queued, running, or recovery required into cancellation
requested. The final state may still be cancelled, timed out, failed, recovery
required, or unsupported depending on process and sandbox behavior.

Retry classification belongs to terminal or recovery-required outcomes. The
server decides whether to retry and creates a new command effect request when
it does. Command runners may classify an outcome as retryable, not retryable,
blocked by policy, missing approval, missing credential, timed out, cancelled,
unsupported, or unknown. They must not loop internally.

Command effect state should become server events after sanitization. The
minimum event vocabulary before implementation is:

- command effect requested
- command effect accepted
- command effect queued
- command effect running
- command approval required
- cancellation requested
- command evidence published
- command retry scheduled
- recovery required

Server events may contain effect ids, command request ids, retry
classification, terminal state, sanitized evidence refs, artifact refs, and
short summaries. They must not contain raw stdout, stderr, environment,
credential material, or machine-local paths by default.

Runtime effect events should share a common server-owned envelope across
adapter and command effects.

Minimum shared event envelope fields:

- stable server event id
- event kind
- event sequence or monotonic ordering token
- effect request id
- event time
- optional prior effect request id for retry-scheduled events
- optional summary

Minimum command effect event payload fields:

- command request id
- current command effect state
- optional terminal command effect state
- optional retry classification
- optional sanitized evidence ref
- optional artifact refs
- optional policy or approval ref

Adapter and command effect events may share the same envelope, but their
payloads stay separate. Command events reference sanitized command evidence.
Adapter events reference normalized observation batches, task-link proposals,
credential-use evidence, webhook-verification evidence, or command-authority
requests.

Retry-scheduled events must point to the prior effect request id and the new
effect request id. The scheduled retry is a new request, not mutation of the
old terminal outcome.

Effect events are reconciliation signals for clients. They are not the
persistence schema, replay store, transport contract, or source of authority
for project, task, workspace, projection, command, or adapter state.

The first Rust runtime effect event types now include a server-owned envelope,
server event sequence token, adapter effect payload variant, command effect
payload variant, symbolic retry linkage, and short summaries. They are
compile-only. They do not implement event transport, subscriptions,
persistence, replay, scheduling, or runtime execution.

## Runtime Effect Replay And Retention Policy

Runtime effect events are split into durable replay events and transient
reconciliation events.

Durable replay events must survive server restart until a later retention
contract says otherwise:

- effect requested
- effect accepted
- effect queued
- effect running
- cancellation requested
- command approval required
- command evidence published
- effect outcome reported
- effect retry scheduled
- recovery required

Transient reconciliation events may be compacted after a durable successor
exists:

- repeated running heartbeats
- repeated queued posture with no state change
- repeated client delivery acknowledgements
- duplicate provider delivery notices after dedupe
- UI-only progress summaries

Retention posture:

- sanitized command evidence refs must remain resolvable while any retained
  command effect event points to them
- artifact refs must remain resolvable according to artifact-retention policy,
  not event-retention policy alone
- observation batch refs must remain resolvable while any retained adapter
  effect event points to them
- retry linkage must remain resolvable at least across the prior terminal event
  and the new requested event
- summaries may be retained after detailed refs expire if the summary does not
  contain raw command output, raw provider payloads, credentials, or
  machine-local paths

Compaction may replace a sequence of non-terminal events with a summary only
after a terminal or recovery-required event exists. Compaction must not remove
the last known terminal state, retry linkage, sanitized evidence ref, artifact
ref, or observation batch ref while those refs are still within retention.

Replay policy may differ by deployment profile. Local-only deployments may keep
shorter replay windows. Remote or multi-client deployments need enough replay
to let clients reconnect and reconcile effect state without becoming
authoritative.

This policy does not choose a database, file format, replay API, event bus,
transport, or artifact store.

The first Rust replay and retention policy types now name replay durability,
transient reconciliation, retained symbolic refs, compaction posture,
deployment profile variance, and sanitized summary retention. They live in the
server crate because replay and retention are server-owned. They do not
implement storage, replay APIs, event transport, subscriptions, artifact
stores, scheduling, or runtime execution.

Runtime effect storage belongs to the server storage boundary. The server must
persist enough normalized event records, command evidence refs, adapter
observation refs, artifact refs, retry lineage, and recovery-required state for
restart recovery and client reconciliation before replay APIs are implemented.
The storage boundary remains separate from event transport, subscriptions,
scheduling, command execution, adapter execution, and artifact-store
implementation.

The first Rust runtime effect storage boundary types now name storage record
ids, replay checkpoint ids, retained event records, stored event kinds, storage
refs, replay checkpoints, stored effect states, and query postures for retained
events, ordering-token reconciliation, ref resolution, latest state, retry
lineage, and recovery-required effects. They are compile-only. They do not
implement a database, serialization, migrations, replay APIs, event transport,
subscriptions, artifact stores, scheduling, command execution, or adapter
execution.

## Runtime Effect Replay Query Boundary

Replay queries are server-owned reconciliation requests.

Clients may ask for retained runtime effect events after reconnect, restart,
view switch, or suspected missed delivery. The query result helps the client
repair its rendered state. It does not make the client authoritative for event
ordering, effect state, retry lineage, recovery state, command evidence, or
adapter observations.

Initial replay query shapes:

- events after ordering token
- events by effect request
- latest effect state
- retry lineage for an effect request
- recovery-required effects
- retained ref resolution

An ordering token is scoped to one server runtime and storage generation unless
a later persistence contract defines cross-generation continuity. It proves
only that the client has seen events through that token from the same server
authority. It does not prove the client has seen every provider event, command
output artifact, task change, workspace change, or projection sync result.

Replay query responses may include:

- retained event records
- compacted replay checkpoints
- latest state summaries
- retry predecessor and successor refs
- recovery-required summaries
- missing-ref notices
- expired-ref notices
- unsupported-query notices
- partial-result notices

Compacted checkpoints are valid replay results. A client that receives a
checkpoint must treat it as server-owned summarized state, not as proof that
the client can reconstruct every original transient event.

Missing refs and expired refs are normal replay outcomes. The server should
return sanitized notices and the best retained summary it can provide. Replay
responses must not include raw command output, terminal byte streams, raw
provider payloads, raw webhook payloads, credentials, or large validation
output by default.

Replay queries are pull-style recovery surfaces. Event subscriptions and live
transport are separate boundaries. A future transport may combine live events
and replay handshakes, but the durable contract remains the server-owned query
semantics, not WebSocket, HTTP, local socket, or any specific protocol.

The first Rust runtime effect replay query types now name client ordering
tokens, storage generation posture, replay query requests, replay query
responses, query status, unsupported reasons, result items, and retained-ref
resolution states. They are compile-only. They do not implement transport,
subscriptions, persistence, replay execution, artifact storage, client caching,
scheduling, command execution, or adapter execution.

## Runtime Effect Subscription Boundary

Runtime effect subscriptions are live delivery surfaces for server-owned
events.

Subscriptions start after a replay catch-up handshake. A client should provide
its last known ordering token when opening a subscription. The server decides
whether to:

- accept live delivery from that token
- require a replay query first
- send a compacted checkpoint before live delivery
- reject the subscription as unsupported for the deployment profile
- ask the client to reconnect after backpressure or generation mismatch

Subscription lifecycle states:

- requested
- replay catch-up required
- accepted
- live
- backpressure
- interrupted
- reconnect required
- closed
- rejected
- unsupported

Delivery acknowledgements are client-rendering hints. They may tell the server
that a client rendered or received events through an ordering token, but they
must not mutate effect state, command evidence, adapter observations, retry
lineage, recovery-required work, task state, workspace state, or storage
retention on their own.

Backpressure is a subscription condition, not permission to drop durable
events. The server may slow delivery, compact transient reconciliation events,
require replay catch-up, or close the subscription with reconnect required.
It must not silently discard durable replay events still needed by retention
policy.

Disconnects are normal. A reconnecting client must reconcile through replay
query or checkpoint before assuming live state is current. Subscription resume
must be based on server ordering tokens and storage generation posture, not on
client-local sequence counters.

Subscription delivery must follow the same sanitization rules as replay query
responses. Live events must not include raw command output, terminal byte
streams, raw provider payloads, raw webhook payloads, credentials, or large
validation output by default.

This boundary does not choose WebSocket, HTTP, local socket, event bus,
message queue, polling, or any other transport. Transport can carry replay
handshakes and live events later, but transport must not become the authority
for event identity, ordering, storage, replay, or effect state.

The first Rust runtime effect subscription types now name subscription ids,
subscription handshakes, lifecycle states, delivery acknowledgement posture,
backpressure posture, disconnect reasons, and reconnect requirements. They are
compile-only. They do not implement transport, an event bus, replay service,
persistence, delivery acknowledgement processing, client caching, scheduling,
command execution, or adapter execution.

## Runtime Effect Transport Selection Boundary

Runtime effect transport is a deployment choice, not the authority surface.

Transport may carry:

- replay query requests and responses
- subscription handshakes
- live runtime effect events
- delivery acknowledgements
- reconnect requirements
- backpressure notices
- sanitized warnings and errors

Transport must preserve:

- server event ids
- server ordering tokens
- storage generation posture
- replay catch-up requirements
- subscription lifecycle state
- retained ref identity
- sanitized summaries
- client identity and connection state
- deployment profile limits

Transport must not own:

- server event identity
- event ordering authority
- replay retention policy
- storage generation identity
- command evidence
- adapter observations
- retry lineage
- recovery-required work
- task or workspace state
- approval authority

Initial transport families to keep available:

- local socket for same-machine desktop or CLI clients
- loopback HTTP for local app integration and development
- LAN HTTP for trusted local-network deployments
- remote HTTP for internet-reachable deployments
- WebSocket or stream transport for live subscription delivery
- polling for constrained or fallback clients
- custom transport for future deployment-specific gateways

Transport selection criteria:

- deployment profile
- client kind
- auth and pairing posture
- live subscription need
- replay-only mode support
- reconnect behavior
- backpressure behavior
- local firewall and network constraints
- remote exposure risk
- implementation maturity

Transport can combine replay and subscription flows later, but it must not
erase the boundary between pull-style replay reconciliation and live
subscription delivery. A reconnecting client still needs replay catch-up or a
checkpoint before it can trust live state.

Auth and pairing are separate blockers. A transport may be technically viable
but not implementation-ready until local pairing, LAN pairing, remote auth,
credential storage, revocation, and client identity policy are defined.

This boundary does not choose a transport, implement networking, implement an
event bus, define auth, define pairing, or implement replay/subscription
delivery.

The first Rust runtime effect transport types now name transport family,
transport profile, transport capability, boundary guarantees, selection
criteria, and auth blockers. They are compile-only. They do not implement
networking, an event bus, auth, pairing, replay, subscription delivery,
storage, scheduling, command execution, or adapter execution.

The first Rust client auth and pairing types now name auth record ids, pairing
ids, auth session ids, auth posture, pairing mode, deployment policy, pairing
records, auth session records, and revocation records. They are compile-only.
They do not implement auth, pairing flows, credential material storage, secret
storage, transport, command approval, provider credentials, model credentials,
or runtime execution.

## Secret Store And Credential Material Boundary

Credential references and credential material are different things.

Server records may store credential references, backend family, material class,
resolution scope, status, redaction posture, rotation posture, revocation
posture, and sanitized audit summaries. Server records must not store raw
credential material unless a later secret-store implementation contract
explicitly defines that backend and its encryption, access, backup, and
rotation behavior.

Credential material may be needed by:

- client auth and pairing
- harness adapter provider auth
- model routes and routing gateways
- SCM adapters
- forge adapters
- webhook verification
- command execution with secret access
- native harness personas
- custom integrations

Credential material backend families:

- host credential provider
- OS keychain
- external secret manager
- provider-native auth state
- future Nucleus secret store
- environment variable
- user-interactive resolution
- custom

Resolution scopes:

- server only
- client auth
- adapter runtime
- model route runtime
- SCM/forge runtime
- command runtime
- webhook verification
- provider-native only
- custom

Raw credential material must not be sent to remote control planes. Runtime
injection, when allowed later, must be scoped to the runtime boundary that needs
it and audited by reference, status, scope, backend family, and sanitized
summary.

Command approval and credential access are separate gates. An authenticated
client may request a command that needs a credential. The command still needs
command authority policy, and the credential still needs credential access
policy. Model output cannot grant either.

Provider-native auth state is not ordinary Nucleus state. Nucleus may store a
reference to provider-owned auth state or configuration, but must not copy the
provider auth file contents into normal storage.

Rotation and revocation are policy events. They may mark client sessions,
adapter instances, model routes, SCM/forge access, webhook verification, and
command execution as unavailable or repair-required. They must not delete
historic audit records, command evidence, adapter observations, or task
history.

This boundary does not select a secret backend, implement encryption, implement
an OS keychain integration, implement provider auth, implement command secret
injection, or expose raw credential material.

The first Rust secret material boundary types now name credential material
refs, material classes, backend families, material statuses, resolution scopes,
resolution requests, access policies, redaction policies, rotation policies,
revocation policies, and sanitized audit records. They are compile-only. They
do not implement a secret store, encryption, backend integration, provider
auth, command execution, credential injection, or raw credential access.

## Credential Resolution Integration Policy

Credential resolution integrates server credential material refs with
domain-specific credential refs.

Initial integration refs:

- client auth refs
- adapter registry secret refs
- model route auth refs
- SCM/forge credential refs
- webhook signing secret refs
- command policy secret refs
- native harness refs
- custom refs

A domain-specific ref may map to a server credential material ref. The mapping
does not resolve material. It only records which server-owned credential ref
would be requested, which runtime scope is allowed, current non-secret status,
blocking impact, and repair action.

Resolution lifecycle states:

- unknown
- available
- missing
- expired
- revoked
- permission denied
- requires user action
- unsupported

Blocking impacts:

- no block
- blocks client auth
- blocks adapter readiness
- blocks model route
- blocks SCM/forge access
- blocks webhook verification
- blocks command execution
- repair required
- custom

Repair actions:

- ask user to pair client
- ask user to log in to provider
- ask user to select credential ref
- ask user to refresh credential
- ask user to grant permission
- mark provider-native auth required
- mark unsupported
- custom

Credential resolution must run before a runtime receives material. Missing,
expired, revoked, permission-denied, requires-user-action, and unsupported
states must surface as repair or policy blockers. They must not become raw
provider errors in normal UI flows.

Command approval still does not imply credential access. Credential access
still does not imply command approval. A command that needs a credential may be
blocked by either policy surface.

Provider-native auth state remains provider-owned. Nucleus may mark
provider-native auth required and point at the provider boundary, but must not
import provider auth files as Nucleus-owned credential material unless a later
explicit import policy defines that behavior.

The first Rust credential resolution integration types now name integration
refs, integration records, blocking impacts, repair actions, and blockers.
They are compile-only. They do not resolve credentials, prompt users, access
backends, inject secrets, execute commands, call providers, or implement UI.

## Credential Resolution Runtime Readiness

Credential resolution implementation may begin only after runtime readiness
surfaces are explicit.

Required runtime readiness surfaces:

- policy preflight before lookup
- backend lookup boundary
- runtime material receiver boundary
- user prompting boundary
- sanitized audit capture
- redaction policy
- repair work emission
- revocation check
- command approval separation

Runtime boundaries that may receive material later:

- server memory only
- process environment injection
- process stdin injection
- SDK sidecar request
- external server request
- provider-native boundary
- webhook verifier
- unsupported
- custom

Lookup readiness states:

- ready
- missing policy
- missing backend
- missing user prompt
- missing audit policy
- missing redaction policy
- blocked by credential status
- unsupported

Credential readiness is not credential resolution. A readiness pass may say a
lookup is allowed, blocked, repair-required, or unsupported. It must not
return raw credential material.

Repair work should be emitted for user-action states such as missing provider
login, missing selected credential ref, expired credential, revoked credential,
permission denied, provider-native auth required, or unsupported backend.
Transient backend failures may stay runtime errors when retry is reasonable and
no user action is needed.

Safe audit capture may retain credential ref, backend kind, resolution scope,
status, failure kind, and short sanitized summary. It must not retain raw
material, decrypted payloads, provider auth files, tokens, private keys,
cookies, authorization headers, command output, or provider error output unless
sanitized.

The first Rust credential runtime readiness types now name runtime material
receiver boundaries, lookup readiness states, preflight records, audit capture
posture, repair work items, and readiness outcomes. They are compile-only.
They do not resolve credentials, prompt users, access backends, inject secrets,
execute commands, call providers, or implement UI.

The first Rust command runtime effect state types now name command effect state
records, non-terminal states, terminal states, and optional retry
classification. They are value-shaped only. They do not implement a scheduler,
transition validator, process supervisor, persistence, replay, artifact store,
or server event fan-out.

## Command Runner And Sandbox Runtime Readiness

Command execution implementation may begin only after pre-execution readiness
surfaces are explicit.

Required command runner readiness surfaces:

- process spawning
- PTY attachment
- sandbox selection
- working-directory validation
- environment construction
- credential injection
- output capture
- cancellation
- timeout
- artifact retention
- sanitized evidence publication

Readiness gates must stay separate from execution. A ready plan may queue a
command for execution later; it must not itself spawn a process, open a PTY,
select a host sandbox backend, resolve credential material, retain output, or
publish command evidence.

Initial readiness blockers:

- missing approval
- missing sandbox policy
- unsupported sandbox profile
- unsupported command scope
- missing working-directory validation
- missing environment plan
- missing credential readiness
- missing output-capture plan
- missing cancellation policy
- missing timeout policy
- missing artifact-retention policy
- missing evidence-publication policy
- raw output retention denied
- custom

Secret-access commands require both command approval and credential readiness.
Command approval does not imply credential access. Credential readiness does
not imply command approval.

Output capture must default to discard, summary-only, or artifact reference
posture. Full output retention needs explicit retention policy and approval
where policy requires it. Raw stdout, raw stderr, terminal byte streams,
environment values, credential values, shell traces, and provider-native auth
material must not be copied into normal evidence, task history, event journals,
or UI logs.

Cancellation and timeout are readiness gates. A runner must declare whether
cancellation is supported, cooperative-only, unsupported, or policy-blocked.
Timeout policy must be planned before execution for commands that can hang or
hold scarce runtime resources.

The first Rust command runner readiness types now name runtime surfaces,
readiness gates, readiness status, blockers, credential-readiness refs,
environment plans, output-capture plans, interruption plans, and full readiness
plans. They are compile-only. They do not spawn processes, select sandbox
backends, construct environments, inject credentials, capture output, retain
artifacts, publish evidence, schedule work, or implement UI.

The first server command runtime readiness envelope binds a command readiness
plan to a server command id. It is compile-only and does not implement
scheduling, process control, sandboxing, credential lookup, output capture,
artifact storage, or event publication.

## Local Command Runner Implementation Contract

The first command runner implementation must be local-only, server-owned, and
read-only. It is an execution path, not a shell.

First executable subset:

- authority area: validation, steward, user terminal, or custom read-only
  inspection only
- scope: read-only inspection only
- risk: low only
- approval: auto-allowed or already approved before runner invocation
- sandbox profile: no filesystem write or project restricted
- command shape: structured executable plus argv, not a shell string
- working directory: existing project or worktree path validated by the server
- environment: minimal inherited-safe environment with no credential material
- output retention: summary-only by default
- timeout: required

The first runner must reject:

- shell passthrough
- source-code writes
- management-state writes
- SCM mutation
- worktree mutation
- network access
- secret access
- destructive commands
- provider process lifecycle commands
- PTY attachment
- unbounded output
- raw stdout/stderr retention without an artifact policy

Process spawning requirements:

- the server must decide the command policy before spawning
- the executable must be a structured field, never parsed from a shell string
- argv must be represented as separate arguments
- working-directory validation must happen before spawn
- the runner must set a timeout before spawn
- the runner must capture stdout/stderr separately
- stdout/stderr may be summarized, truncated, or referenced by artifact id
- raw output must not be copied into task history, event journals, normal logs,
  or UI state

Initial sanitized evidence must include:

- command request id
- status
- exit status when known
- output retention posture
- optional stdout artifact ref
- optional stderr artifact ref
- short sanitized summary

Initial cancellation posture is cooperative-only or unsupported. A timeout
must produce timed-out evidence. A failed spawn must produce failed evidence
without pretending the process ran.

The first implementation may use host process spawning for the local-only
profile. This does not select the long-term sandbox backend. Broader sandbox
profiles, PTY execution, streaming output, artifact payload storage, network
commands, secret-backed commands, provider process lifecycle, and remote
execution remain separate future contracts.

## Command Execution Readiness Assessment

The first gate-only runner proves request classification and sanitized evidence
shape. It does not make broader command execution ready.

Host process spawning remains blocked until the server has:

- structured command invocation records with executable, argv, working
  directory, timeout, and output bound
- environment construction rules
- timeout and cancellation implementation rules
- artifact payload policy for raw stdout/stderr when retained
- sandbox enforcement strategy, not only sandbox labels
- event publication rules for queued, blocked, running, and terminal evidence

Persisted command evidence and `nucleusd` command evidence query output now
exist for the fixed gate-only smoke path. Query output remains sanitized and
does not expose raw process output.

The next implementation lane should define local process supervision,
invocation records, timeout/cancellation semantics, and sandbox limits before
adding host process spawning.

## Local Process Supervision Contract

Local process supervision is the server-owned runtime boundary for host child
processes. It is narrower than command authority. Command authority decides
whether a request may run; process supervision starts, observes, interrupts,
and finalizes a local process only after that authority exists.

The first process supervisor may support only:

- local host child process
- read-only inspection scope
- low risk
- validation, steward, user terminal, or custom read-only authority area
- auto-allowed or already-approved request
- structured executable plus argv
- existing project or worktree working directory
- bounded stdout and stderr capture
- required timeout
- summary-only evidence by default

The first process supervisor must not support:

- shell strings or shell passthrough
- PTY allocation
- interactive stdin
- network-enabled commands
- secret material or credential lookup
- source-code writes
- management-state writes
- SCM mutation
- worktree mutation
- destructive commands
- provider process lifecycle commands
- unbounded output
- background processes detached from the server

Structured invocation record requirements:

- executable is a field, not parsed from a string
- argv is a list of arguments, not shell text
- working directory is validated before spawn
- timeout is required and finite
- stdout and stderr byte limits are required
- environment policy is named before spawn
- sandbox policy is named before spawn
- output retention policy is named before spawn
- command request id is linked before spawn

Environment construction rules:

- start from a minimal server-selected environment, not full inherited host
  environment by default
- include no provider credentials, API keys, tokens, SSH agent paths, keychain
  refs, or secret file paths
- include only allowlisted variables needed for local tool execution
- record the environment policy name in evidence, not environment values
- reject requests that require credential material until the secret-store
  contract defines that flow

Timeout and cancellation rules:

- timeout starts either before spawn attempt or after spawn success; the
  implementation must choose and document one exact interpretation before
  spawn is allowed
- timeout must produce timed-out evidence even if process cleanup also fails
- cancellation request is not a terminal state
- terminal state must distinguish succeeded, failed, cancelled, timed out,
  failed spawn, blocked by policy, and cleanup failed
- cleanup failure must be visible as sanitized evidence
- cleanup failure must emit a cleanup-failed event or equivalent sanitized
  evidence ref; it must not be hidden inside a generic failure summary
- retry must remain server-scheduled and policy-aware
- cancellation behavior must be named before spawn; `Unsupported` cancellation
  is not acceptable for unattended local spawn

Output capture rules:

- stdout and stderr are captured separately
- each stream has a byte limit before spawn
- exceeding a byte limit must stop capture, truncate, or terminate according to
  a named policy
- summaries must be sanitized and bounded
- raw output must not enter task history, event journals, normal logs, UI
  state, or projection records by default
- artifact refs require artifact policy; artifact payload storage remains a
  separate boundary

Sandbox honesty rule:

The first local host-spawn slice may use labels such as `NoFilesystemWrite` or
`ProjectRestricted` only if the implementation honestly enforces that posture.
If the host cannot enforce no-write behavior, the runner must either stay
gate-only or use a weaker explicit sandbox label. Nucleus must not present a
sandbox profile as enforced when it is only advisory.

Local host execution safety strategy:

- `HostDefault` is advisory and must not be used for unattended spawn.
- `NoFilesystemWrite` is enforceable only when the host proves writes are
  blocked by an OS sandbox, container, mount policy, or equivalent mechanism.
- `ProjectRestricted` is enforceable only when filesystem access is confined to
  approved project or worktree roots and escapes are rejected before spawn.
- `WorktreeRestricted` is enforceable only when the allowed root is one
  recorded worktree and path escapes are rejected before spawn.
- `NetworkDenied` is enforceable only when outbound network access is blocked
  by the host runtime, not just omitted from command intent.
- `NetworkAllowed` is not part of the first local read-only spawn class.
- `Custom` profiles are blocked until their enforcement backend and evidence
  shape are named.

Gate-only command runners may inspect these labels and reject unsupported
requests, but they must not claim sandbox enforcement. Evidence may record the
requested sandbox label and a gate-only disposition; it must not record an
advisory label as enforced.

First allowed future spawn class:

- local execution host has project execution authority
- command authority already accepted the request
- scope is `ReadOnlyInspection`
- risk is `Low`
- approval is `AutoAllowed` or already approved by policy
- executable and argv are structured
- shell passthrough is rejected
- working directory is an existing project or worktree root or descendant
- environment is minimal and allowlisted
- timeout is finite and required
- stdout and stderr limits are finite and required
- output retention is summary-only unless artifact policy explicitly allows
  payload retention
- sandbox enforcement status is `Enforced`, not advisory

If any of those conditions fail, the process supervisor must stay at blocked or
queued evidence and must not emit running evidence.

Event publication rules:

- queued evidence is not proof of process start
- running evidence is not proof of process completion
- terminal evidence must include status, exit status when known, retention
  posture, optional artifact refs, and sanitized summary
- client event streams may reference evidence ids; they must not copy raw
  output by default

Host process spawning remains blocked until structured invocation records,
process supervision readiness, event payloads, acceptance checks, sandbox
enforcement, artifact payload policy, timeout behavior, and cancellation
behavior prove these constraints without pretending a process ran.

`nucleus-command-policy` now contains first-pass process supervision readiness
vocabulary:

- `CommandProcessSupervisionReadinessStatus`
- `CommandProcessSupervisionSurface`
- `CommandProcessSupervisionBlocker`
- `CommandTimeoutPolicy`
- `CommandCancellationPolicy`
- `CommandOutputBoundPolicy`
- `CommandSandboxEnforcement`
- `CommandProcessSupervisionReadiness`

These types are compile-only. They do not spawn processes, select an async
runtime, enforce sandboxes, capture output, interrupt children, store
artifacts, publish events, or prove host execution is safe.

## First Host Spawn Readiness Assessment

The first host-spawn slice is not ready yet.

Closed prerequisites:

- command evidence can be persisted and queried
- command evidence output remains sanitized
- structured invocation records exist
- process supervision readiness types exist
- process supervision event payload types exist
- process supervisor acceptance skeleton exists
- process supervision contract names timeout, cancellation, environment,
  output, sandbox, and event requirements

Remaining blockers:

- no concrete sandbox enforcement strategy exists for `NoFilesystemWrite` or
  `ProjectRestricted`
- no event transport exists for process start, running, terminal, and
  cleanup-failed evidence
- no artifact payload policy exists for retained stdout/stderr bytes
- no implementation-level timeout and cancellation behavior has been proven

The next lane must define host execution safety and artifact policy. It must
still avoid starting child processes until sandbox enforcement,
output/artifact behavior, timeout behavior, and cancellation behavior are
honest.

## Process Supervisor Module And Event Boundary

The process supervisor module is a host runtime boundary. It is separate from
command authority, host authority, storage, and event transport.

Before supervisor acceptance, the host must have:

- project authority-map assignment for execution authority
- command authority accepted for the request
- structured invocation record
- process supervision readiness plan
- evidence publication policy

Supervisor responsibilities:

- accept or reject a process supervision request
- preserve command request id and project id refs
- preserve authoritative execution host id
- publish evidence-ref based supervision events
- keep sandbox enforcement blockers visible
- keep raw stdout/stderr out of event payloads
- report terminal and cleanup-failed states separately

Supervisor event categories:

- accepted: supervisor accepted a policy-ready request for future execution
- blocked: supervisor rejected a request before execution
- queued: supervisor queued a request without process start
- running: process start was observed
- terminal: process reached succeeded, failed, cancelled, or timed-out state
- cleanup failed: process interruption or cleanup failed after terminal or
  timeout handling

Supervisor events may carry:

- event id
- project id
- command request id
- execution host id
- supervision status
- command evidence ref
- sanitized summary
- retry classification ref where available

Supervisor events must not carry:

- raw stdout
- raw stderr
- terminal byte streams
- environment values
- credential values
- secret file paths
- provider-native auth material
- unredacted filesystem listings

The first process supervisor implementation must remain non-spawning until the
event types and acceptance skeleton prove these boundaries. A ready
supervision acceptance is still not proof that a child process ran.

Current Rust surface:

- `CommandProcessSupervisionEventId`
- `CommandProcessSupervisionRetryRef`
- `CommandProcessSupervisionEventPayload`
- `CommandProcessSupervisionEventKind`
- `CommandProcessSupervisionStatus`
- `CommandProcessTerminalStatus`
- `CommandTimeoutStartPolicy`
- `CommandCleanupFailurePolicy`
- `CommandProcessInterruptionContract`
- `ProcessSupervisionServerEvent`
- `ProcessInterruptionHostContract`
- `ProcessSupervisorAcceptanceRequest`
- `ProcessSupervisorAcceptanceDecision`
- `ProcessSupervisorAcceptedEvents`
- `ProcessSupervisorAcceptanceRejection`
- `ProcessSupervisorAcceptanceRejectionReason`
- `accept_process_supervision_request`

These types preserve command request, project, execution host, evidence, policy
decision, and retry refs. They do not include raw stdout, raw stderr, terminal
streams, environment values, process spawning, event transport, persistence, or
artifact payload storage.

The first acceptance skeleton checks execution authority from the project
authority map and rejects blocked readiness plans. Ready requests emit accepted
and queued event values only; they do not produce running or terminal events
and still do not prove any child process ran.

The first interruption contract requires finite timeout policy, a named timeout
start interpretation, supported cancellation behavior, cleanup-failed event
visibility, terminal event visibility, and policy-aware retry classification.
It does not implement async process control, kill-tree behavior, cleanup,
retry scheduling, or event transport.

## Second Host Spawn Readiness Assessment

The first host-spawn slice is still not ready.

Closed prerequisites:

- command evidence can be persisted and queried
- command evidence output remains sanitized
- structured invocation records exist
- process supervision readiness types exist
- process supervision event payload types exist
- process supervisor acceptance skeleton exists
- local host execution safety strategy is explicit
- artifact payload retention policy is explicit
- timeout and cancellation implementation contract is explicit

Remaining blockers:

- no OS sandbox, container, mount policy, or equivalent enforcement backend
  proves `NoFilesystemWrite`, `ProjectRestricted`, `WorktreeRestricted`, or
  `NetworkDenied`
- no artifact payload storage implementation exists behind the retention policy
- no event transport exists for running, terminal, and cleanup-failed process
  supervision events
- no async process control implementation exists for timeout, cancellation, or
  cleanup

## Host Runtime Backend Readiness Descriptors

Host-spawn backend readiness is descriptor-based, not boolean-only.

Backend descriptor families:

- sandbox backend readiness: backend kind, enforced profiles, enforcement
  posture, and enforcement evidence refs
- artifact store backend readiness: backend kind, supported payload classes,
  payload storage readiness, retention evidence refs, and redaction evidence
  refs
- process event transport readiness: backend kind, supported supervision event
  kinds, delivery evidence refs, and replay evidence refs
- process-control backend readiness: backend kind, spawn, timeout,
  cancellation, cleanup support, and implementation evidence refs

Descriptors are evidence surfaces only. They do not implement sandboxing,
artifact payload storage, event transport, process spawning, timeout,
cancellation, cleanup, or UI rendering.

Current Rust surface:

- `SandboxBackendReadiness`
- `SandboxBackendKind`
- `SandboxBackendEvidenceRef`
- `ArtifactStoreBackendReadiness`
- `ArtifactStoreBackendKind`
- `ArtifactStoreBackendEvidenceRef`
- `ProcessEventTransportReadiness`
- `ProcessEventTransportBackendKind`
- `ProcessEventTransportEvidenceRef`
- `ProcessControlBackendReadiness`
- `ProcessControlBackendKind`
- `ProcessControlBackendEvidenceRef`

## Local Host Runtime Discovery Vocabulary

Local host runtime discovery is a non-spawning server vocabulary for descriptor
production.

It may report:

- local host runtime discovery status: ready, degraded, or unsupported
- sandbox backend readiness descriptor
- artifact store backend readiness descriptor
- process event transport readiness descriptor
- process-control backend readiness descriptor
- discovery evidence refs
- discovery findings such as unsupported backends or descriptor host mismatch

Discovery records are values only. They do not probe the machine, spawn
processes, enforce sandboxes, store artifacts, publish events, control child
processes, choose an async runtime, or repair missing capability.

Current Rust surface:

- `LocalHostRuntimeDiscovery`
- `LocalHostRuntimeDiscoveryStatus`
- `LocalHostRuntimeDiscoveryFinding`
- `LocalHostRuntimeDiscoveryEvidenceRef`
- `LocalHostRuntimeDiscoveryGateInput`
- `unsupported_local_host_runtime_discovery`
- `evaluate_host_spawn_readiness_from_discovery`

Discovery may feed the host-spawn readiness gate through an explicit
composition input. The composition keeps project id, authority readiness,
supervisor decision, requested sandbox profile, required artifact payload
classes, interruption contract, and summary explicit. Discovery supplies only
backend descriptors and execution host id.

Unsupported discovery is a valid result. When composed with otherwise-ready
authority, supervisor, and interruption inputs, unsupported backend descriptors
must keep host-spawn readiness blocked with concrete backend blockers.

## Host Spawn Readiness Gate

The host-spawn readiness gate is a server-owned, non-spawning decision surface.
It composes authority, supervisor acceptance, requested sandbox profile,
sandbox backend readiness, artifact store backend readiness, process event
transport readiness, interruption contract readiness, and process-control
backend readiness into one value.

The gate may return ready only when all of these are true:

- project execution authority is ready for the execution host
- process supervisor accepted the request
- sandbox backend supports the requested sandbox profile with evidence refs
- artifact store backend supports all required artifact payload classes with
  retention and redaction evidence refs
- event transport backend supports running, terminal, and cleanup-failed
  supervision events with delivery and replay evidence refs
- interruption contract is present and ready
- process-control backend supports spawn, timeout, cancellation, and cleanup
  with implementation evidence refs

The gate must return blocked when any of these blockers are present:

- execution authority is missing, assigned to another host, or mutation-denied
- supervisor acceptance is blocked or rejected
- sandbox backend is missing, advisory-only, unsupported, lacks evidence, or
  does not support the requested sandbox profile
- artifact store backend is missing, unsupported, lacks evidence, or does not
  support required payload classes
- event transport backend is missing, unsupported, lacks evidence, or cannot
  carry running, terminal, and cleanup-failed events
- interruption contract is missing or not ready
- process-control backend is missing, unsupported, lacks evidence, or cannot
  support spawn, timeout, cancellation, and cleanup

The gate does not spawn processes, enforce sandboxes, store artifacts, publish
events, control child processes, choose an async runtime, or select a sandbox
backend. A ready gate is permission to enter a backend implementation boundary,
not proof that a process ran.

Current Rust surface:

- `HostSpawnReadinessInput`
- `HostSpawnReadinessGate`
- `HostSpawnReadinessStatus`
- `HostSpawnReadinessBlocker`
- `evaluate_host_spawn_readiness`

The tests prove missing or incomplete sandbox, artifact store, event transport,
interruption contract, and process-control descriptors each keep readiness
blocked. They also prove combined blockers remain visible for diagnostics and
UI surfaces.

## Fourth Host Spawn Readiness Assessment

The first host-spawn implementation is closer, but still not ready.

Closed prerequisites:

- host-spawn readiness gate exists and uses typed backend descriptors
- sandbox, artifact store, event transport, and process-control readiness are
  descriptor-backed
- descriptor tests prove missing evidence and unsupported capabilities block
  readiness

Remaining blockers:

- descriptor values are still manually constructed test values
- no host runtime discovery builds descriptors from real local capabilities
- no backend-specific implementation exists for sandbox enforcement
- no backend-specific implementation exists for artifact payload storage
- no backend-specific implementation exists for process event transport
- no backend-specific implementation exists for process control

The next lane should add local host runtime capability discovery that produces
backend descriptors. It must remain non-spawning.

Real local process spawning remains blocked until concrete sandbox, artifact
store, event transport, and process-control backends exist behind this gate.

## Fifth Host Spawn Readiness Assessment

The first host-spawn implementation is still blocked.

Closed prerequisites:

- local host runtime discovery vocabulary exists
- unsupported local host runtime discovery fixture exists
- discovery output can feed the host-spawn readiness gate
- unsupported discovery produces concrete sandbox, artifact store, event
  transport, and process-control blockers

Remaining blockers:

- no concrete local sandbox backend implementation is selected
- no concrete local artifact store backend implementation is selected
- no concrete local event transport backend implementation is selected
- no concrete local process-control backend implementation is selected
- the first spawn slice needs a narrow implementation runway that introduces
  one backend at a time behind the existing gate

The next lane should compile a local runtime backend implementation runway
before attempting real process spawn.

## Local Runtime Backend Implementation Runway

First concrete local runtime backend work should land in dependency order:

1. artifact store backend
2. event transport backend
3. sandbox backend
4. process-control backend
5. first read-only spawn implementation

Reason:

- artifact storage and event transport are evidence plumbing and do not require
  child process spawn
- sandbox and process-control work should not begin until evidence capture can
  describe what happened
- process-control is the last backend before spawn because it is the first
  slice that can cross into real child-process behavior

Before backend implementation, oversized server modules should be split where
they block clean ownership. In particular, host-spawn readiness test helpers
and discovery composition fixtures must not keep accumulating in
`host_spawn_readiness.rs`.

First backend slice definitions:

- artifact store: local filesystem-backed sanitized metadata and bounded text
  artifact refs under the server state root; no raw secret material; no remote
  object storage; evidence refs must distinguish retention policy from
  redaction policy
- event transport: in-process supervision event bus with replay from existing
  server event/effect storage vocabulary; must support running, terminal, and
  cleanup-failed event kinds; no remote streaming
- sandbox: advisory unsupported by default plus an explicitly selected first
  enforceable local profile; unsupported platforms must produce unsupported
  discovery, not pretend readiness
- process control: finite-timeout, bounded-output, read-only command spawn
  only after artifact, event, and sandbox descriptors are implemented; no PTY,
  shell passthrough, terminal rendering, or remote process execution

Real spawn remains blocked until all backend descriptors are produced by
concrete backend slices and the host-spawn readiness gate returns ready.

## Third Host Spawn Readiness Assessment

The first host-spawn slice is still not ready.

Closed prerequisites:

- command evidence can be persisted and queried
- command evidence output remains sanitized
- structured invocation records exist
- process supervision readiness types exist
- process supervision event payload types exist
- process supervisor acceptance skeleton exists
- local host execution safety strategy is explicit
- artifact payload retention policy is explicit
- timeout and cancellation implementation contract is explicit
- host-spawn readiness gate exists and preserves blocker detail

Remaining blockers:

- sandbox readiness is still represented as a coarse enforcement value, not a
  backend descriptor with evidence of actual enforcement
- artifact store readiness is still a boolean, not a backend descriptor with
  payload class support and retention evidence
- event transport readiness is still a boolean, not a transport descriptor for
  running, terminal, and cleanup-failed supervision events
- process-control readiness is still a boolean, not an implementation
  descriptor for spawn, timeout, cancellation, and cleanup behavior

The next lane should replace coarse backend booleans with typed backend
readiness descriptors. It must remain non-spawning.

## Command Artifact Store And Output Retention Boundary

Command artifacts are payload refs outside command evidence.

Command evidence may retain artifact refs and short sanitized summaries. It
must not embed raw stdout, raw stderr, terminal byte streams, shell traces,
environment values, credential material, provider-native auth files, or large
validation output by default.

Initial command artifact payload classes:

- stdout
- stderr
- combined output
- terminal transcript
- validation report
- sanitized summary
- custom

Initial artifact resolution states:

- resolvable
- missing
- expired
- redacted
- compacted to summary
- unsupported

Artifact refs are not proof that payloads still exist. A retained event,
command evidence record, task history record, or replay checkpoint may outlive
the artifact payload. Clients must treat artifact resolution as a separate
server query and handle missing, expired, redacted, compacted, and unsupported
states explicitly.

Full command output retention requires:

- explicit retention policy
- approval where policy requires it
- payload class that policy permits
- secret scan passed or findings redacted
- redaction applied or not required
- artifact payload stored outside command evidence, event journals, task
  history, replay checkpoints, and normal logs
- secret scanning before publication or replay exposure
- redaction policy before publication or replay exposure
- sanitized audit summary

Artifact payload retention rules:

- stdout, stderr, combined output, and terminal transcript payloads are raw
  process output.
- raw process output payload storage requires `FullArtifactWithApproval`,
  satisfied approval, secret scanning, and redaction policy.
- summary-only retention may store sanitized summary payloads, not raw stream
  bytes.
- validation reports may be stored as artifact payloads only after secret scan
  and redaction policy have passed.
- custom payload classes are blocked until their policy and scanner behavior
  are named.
- artifact refs may appear in command evidence and events; artifact payload
  bytes must be resolved through a separate artifact query.

Secret scanning and redaction status must be visible as metadata. A full-output
artifact ref must not be treated as resolvable when approval is missing, secret
scanning is required but not run, secret findings are blocked, redaction is
pending, redaction failed, or the scanner/redactor is unsupported for a policy
that requires it.

The artifact store boundary does not choose a backend. Filesystem blobs,
embedded database blobs, object storage, project-local files, remote storage,
or custom stores remain storage implementation choices.

The first Rust command artifact types now name payload classes, approval
requirements, secret-scan status, redaction status, resolution status,
retention policy, and artifact descriptors. They are compile-only and store no
payloads.

The first server command artifact envelope binds artifact descriptors to server
command ids and exposes resolution status. It is compile-only and does not
implement storage, scanning, redaction, payload reads, payload writes, or UI
rendering.

The first local artifact-store backend implementation now exists in
`nucleus-server`.

Implemented boundary:

- `LocalArtifactStoreBackend`
- `LocalArtifactMetadataStore`
- `LocalArtifactMetadataRecord`
- `LocalArtifactMetadataId`
- `LocalArtifactStoreError`
- `with_local_artifact_store_readiness`

The backend owns a server state root and reports filesystem readiness only
after its metadata directory exists. The first accepted payload classes are
sanitized summary and validation report. Metadata is written as sanitized JSON
under the state root; payload bytes are not stored by this boundary.

Default local artifact storage rejects raw process output payload classes:

- stdout
- stderr
- combined output
- terminal transcript

It also rejects obvious secret-material markers in metadata summaries. This is
a first guardrail, not a substitute for the later scanner and redactor
pipeline. Full output retention remains blocked until explicit approval,
scanner, redaction, and payload-store behavior are implemented.

Local runtime discovery can now compose concrete artifact-store readiness into
an otherwise unsupported discovery result. This removes the artifact-store
host-spawn blocker while keeping sandbox, event transport, and process-control
blockers intact.

The first local event transport backend implementation now exists in
`nucleus-server`.

Implemented boundary:

- `LocalEventTransportBackend`
- `LocalSupervisionEventChannel`
- `LocalEventTransportChannelId`
- `LocalEventTransportReplayPosture`
- `LocalEventTransportError`
- `with_local_event_transport_readiness`

The backend names an in-process supervision event channel for one execution
host. It reports readiness for the required future spawn event kinds:

- running
- terminal
- cleanup failed

Delivery evidence and replay evidence are separate. Replay readiness is
metadata-ref only in this slice. This does not implement a durable replay
store, live subscriptions, remote streaming, sockets, process spawn, or client
event fanout.

Local runtime discovery can now compose concrete event transport readiness into
an otherwise degraded discovery result. With local artifact store and local
event transport readiness composed, host-spawn readiness remains blocked by
sandbox and process-control descriptors.

The first local sandbox backend implementation now exists in `nucleus-server`.

Implemented boundary:

- `LocalSandboxBackend`
- `LocalSandboxBackendId`
- `LocalSandboxBackendPosture`
- `LocalSandboxBackendPlatform`
- `LocalSandboxProfileSupport`
- `LocalSandboxError`
- `with_local_sandbox_readiness`

The backend can report enforced readiness for the `NoFilesystemWrite` profile
with evidence refs. Unsupported and advisory-only postures remain explicit
states and do not satisfy host-spawn readiness. This boundary still does not
spawn processes, enforce OS policy, create containers, rewrite mounts, inspect
paths, or run shell commands.

Local runtime discovery can now compose concrete sandbox readiness into an
otherwise degraded discovery result. With local artifact store, local event
transport, and local sandbox readiness composed, host-spawn readiness remains
blocked by process-control descriptors.

The first local process-control backend implementation now exists in
`nucleus-server`.

Implemented boundary:

- `LocalProcessControlBackend`
- `LocalProcessControlBackendId`
- `LocalProcessControlRuntime`
- `LocalProcessControlReadinessProfile`
- `LocalProcessControlError`
- `with_local_process_control_readiness`

The backend can report readiness for the first bounded read-only spawn control
profile. The readiness profile keeps these controls explicit:

- spawn readiness
- finite timeout readiness
- cooperative cancellation readiness
- cleanup failure reporting readiness
- shell passthrough disabled
- PTY disabled

This boundary still does not spawn processes, start async runtimes, cancel
child processes, kill process trees, run cleanup, or open PTYs.

Local runtime discovery can now compose concrete process-control readiness into
an otherwise degraded discovery result. With local artifact store, local event
transport, local sandbox, and local process-control readiness composed, the
host-spawn readiness gate can report ready without spawning.

The first bounded read-only local spawn boundary now exists in
`nucleus-server`.

Implemented boundary:

- `run_local_read_only_spawn`
- `LocalReadOnlySpawnInput`
- `LocalReadOnlySpawnResult`
- `LocalReadOnlySpawnOutcome`
- `LocalReadOnlySpawnOutputSummary`
- `LocalReadOnlySpawnRejection`
- `LocalReadOnlySpawnError`

The boundary requires a ready host-spawn gate before any process spawn attempt.
It reuses the local read-only command runner policy checks, rejects shell
passthrough, runs structured executable-plus-argv invocations, sets stdin to
null, captures stdout and stderr through bounded readers, enforces finite
timeout, and returns sanitized command evidence plus deterministic supervision
events.

Default evidence does not persist raw stdout, raw stderr, terminal byte
streams, shell traces, environment values, or credential material. Output is
reported as captured-byte counts and truncation flags only. Full artifact
payload storage remains outside this boundary.

The boundary is not yet wired into the server command runner smoke command or
control API. The next lane should expose this through a narrow server-owned
helper and smoke path before expanding command classes.

## Implementation Gap Classification

The server boundary has enough first-pass contract shape to compile an
implementation runway. Remaining gaps should be treated by implementation lane,
not as a reason to keep widening the foundation pass.

Foundation blockers before implementation runway:

- choose the first implementation slice and success criteria inside `g01`
- decide which runtime boundaries are intentionally out of scope for that first
  slice
- keep command execution, provider adapters, and Tauri app behavior out of the
  first slice unless the runway explicitly promotes them

First implementation decisions:

- minimal server state store shape for projects, tasks, adapter registry,
  sessions, and runtime refs
- initial local-only control API transport for development
- initial local-only auth posture and pairing bypass policy
- minimal event journal and replay query needed for restart recovery
- type-to-storage mapping for server events, command evidence, artifact
  metadata, credential refs, and runtime effect state
- first async runtime and internal task scheduling approach if runtime effects
  enter the first slice

Subsystem implementation decisions:

- LAN and internet auth and pairing
- event subscription transport
- replay compaction and retention implementation
- command runner implementation boundary
- sandbox backend mapping to host OS isolation primitives
- command approval prompt transport across clients
- artifact payload backend and payload lifecycle
- secret backend and credential material lookup
- credential prompting and repair-work UI

Already promoted from earlier research gaps:

- dev-only command fixture crate boundary
- command effect request and outcome type shape
- cancellation, timeout, retry, and artifact-retention vocabulary
- runtime effect state and event vocabulary
- server event envelope Rust type boundary
- replay, retention, query, subscription, and transport boundary vocabulary
- client auth and pairing boundary
- secret material and credential readiness boundary
- command runner readiness boundary
- command artifact and output-retention boundary
