# 007 Server Boundary Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the server boundary that all control planes use.

The server is the nucleus authority surface. Desktop, web, mobile, CLI, and
service clients are control planes over the same server-owned state.

## Authority Rule

The server owns:

- project records
- repo membership and path history
- task state
- agent session records
- workspace layouts
- terminal attachment state
- browser attachment state
- harness process lifecycle
- model routes

Clients may cache and render state, but must reconcile with server state.
Tauri must not become the authority for project, task, workspace, or agent
state.

## Deployment Boundary

A deployment has:

- one running server runtime
- one deployment mode
- one or more access endpoints
- one or more clients connected through those endpoints

Initial deployment modes:

- local-only
- local network
- internet reachable
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
- secret scanning before publication or replay exposure
- redaction policy before publication or replay exposure
- sanitized audit summary

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
