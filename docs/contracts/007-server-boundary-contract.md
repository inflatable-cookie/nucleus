# 007 Server Boundary Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

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

## Research Gaps

- Whether the first API should be HTTP/WebSocket, local socket, or both.
- How auth and pairing should work for LAN and internet deployments.
- How event subscriptions and replay should be represented.
- How command acceptance, rejection, queueing, and results should be modeled.
- How server state persists across restarts.
- How command sandbox profiles map to host OS isolation primitives.
- How command approval prompts are represented across clients.
- Dev-only command fixture crate boundary.
- Runtime command effect request and outcome type shapes.
- Cancellation, timeout, retry, and artifact-retention policy.
- Server event payload shape for command effect state changes.
