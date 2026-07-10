# 019 Conversation Timeline Contract

Status: draft
Owner: Tom
Updated: 2026-07-09

## Purpose

Define the canonical timeline entities used to map tasks, agent sessions,
provider events, tool calls, checkpoints, and user-visible conversation state.

Provider-native ids are preserved, but they do not replace Nucleus timeline
ids.

## Timeline Rule

Nucleus owns a canonical timeline for agentic work.

Provider adapters translate provider events into timeline events. They must
preserve provider ids and capability differences without pretending every
harness has the same model.

## Core Entities

Initial entities:

- project
- task
- work item
- agent session
- thread
- turn
- message
- activity
- tool call
- permission request
- runtime receipt
- checkpoint
- artifact ref

## Identity Rule

Each canonical entity needs a stable Nucleus id.

Provider-native ids are stored as external refs with:

- provider family
- adapter instance ref
- provider id kind
- provider id value
- confidence or synthetic marker where needed

Synthetic ids are allowed when a provider omits stable ids. Synthetic ids must
be marked as synthetic and derived from stable surrounding context when
possible.

## Task And Work Item Rule

A task may spawn one or more work items.

A work item is the unit Nucleus can delegate, pause, recover, validate, and
summarize. It may map to one agent session, several sessions, a human action,
an SCM workflow, a research run, or a mixed workflow.

Task history links to work items and summaries. It must not copy full provider
transcripts or runtime streams by default.

The first engine work item record links a task to runtime evidence by refs:
agent session id, turn ids, runtime receipt ids, checkpoint ids, timeline entry
ids, validation refs, and artifact refs. Work-item runtime projections are
rebuilt from those refs in stable order and contain sanitized summaries only.

Work-item review transitions are timeline facts, not provider messages.
Operator acceptance, rejection, needs-changes, and abandonment remain separate
from runtime completion and parent task completion.

`023-task-backed-agent-workflow-contract.md` owns the allowed work-item
lifecycle states and transitions. This contract owns how those facts appear in
canonical timelines.

## Session, Thread, And Turn Rule

An agent session binds Nucleus to one configured adapter instance and runtime.

A thread is the conversation continuity unit exposed to users. Depending on the
provider, a session may map to one provider thread, one CLI process, one ACP
session, one SDK query context, or a recovered transcript projection.

A turn is one user, agent, or system-directed exchange boundary. Providers may
split or merge these differently; adapters must record mapping confidence.

## Message Rule

Messages are canonical timeline items.

Message records should identify:

- message id
- thread id
- turn id where known
- role
- content refs or sanitized content
- provider refs
- ordering position
- artifact refs
- redaction state

Raw provider payloads should be retained only behind artifact or evidence
policy when needed.

## Activity Rule

Activities represent non-message timeline facts.

Initial activity kinds:

- tool call started
- tool call completed
- permission requested
- permission resolved
- command requested
- command completed
- file change observed
- checkpoint created
- validation recorded
- provider state changed
- recovery attempted
- recovery completed
- custom

Activities may appear in client timelines, but clients must not infer that all
activities are human-readable messages.

## Task Timeline Projection Rule

The first implemented timeline projection is task-scoped and read-only.

It maps task-family command-admitted orchestration events into task timeline
entries when the event target is a concrete task id.

Initial task timeline entries carry:

- stable timeline entry id
- task id
- entry kind
- source command id
- source event id
- source projection cursor
- sanitized human-readable summary

The first projection intentionally does not copy raw provider payloads,
runtime streams, terminal output, or tool-call payloads.

Current limitation: task creation command-admitted events target the project,
not the newly created task id. Those events are not part of the first
task-scoped projection until a later task-state event or richer command event
links project-scoped creation to the created task id.

## Ordering Rule

Timeline ordering needs both:

- event stream order for durable replay
- display order for user-facing conversation views

Provider timestamps are evidence, not authority. The authoritative host assigns
event order when ingesting provider events.

## Recovery Rule

Recovery must preserve uncertainty.

After restart or provider reconnect, timeline state may be:

- complete
- complete with synthetic ids
- partial
- transcript-only
- provider-recoverable
- unrecoverable
- unknown

Clients must render recovery uncertainty instead of pretending all provider
sessions resume equally.

## Codex Static Fixture Mapping

The first Codex app-server timeline mapping is static and fixture-backed.

`nucleus-agent-protocol` maps verified Codex-shaped methods into canonical
runtime events before any live app-server process is supervised.

Covered fixture classes:

- thread start and resume
- turn start and complete
- item lifecycle
- assistant content delta
- tool-call start
- approval request
- user-input request
- warning and error diagnostics

Nucleus event ids remain authoritative. Codex thread, turn, item, request, and
session ids are retained as provider refs.

Unsupported method/payload combinations must fail closed. They may become
diagnostics only through an explicit mapping, not by silent best-effort
projection.

Raw provider fixture data is retained only as sanitized raw payload evidence.
Live provider payload retention remains governed by artifact and evidence
policy.

## Relationship To Other Contracts

- `005-task-contract.md` owns task fields and task history summaries.
- `010-agent-session-lifecycle-contract.md` owns lifecycle transitions.
- `018-orchestration-contract.md` owns commands, events, and projections.
- `020-runtime-receipt-contract.md` owns side-effect evidence.
- `021-checkpoint-diff-contract.md` owns change boundaries.
- `023-task-backed-agent-workflow-contract.md` owns task-backed work-item
  lifecycle sequencing and Codex task binding rules.

## Initial Product Chat Continuity

The product Agent Chat slice persists server-owned session, turn, and ordered
user/assistant message records in the agent-session persistence domain.
Provider thread ids remain external refs attached to the Nucleus session.

On local runtime restart, Nucleus reloads the canonical display history and
requests provider-thread resume. An unexplained replacement provider thread
must not be presented as the same conversation.

Codex dynamic tools are selected at thread start and cannot be added by thread
resume. When a persisted session predates the current Nucleus chat toolset,
Nucleus performs an explicit capability migration: it keeps the canonical
conversation and bounded transcript context, starts a tool-enabled provider
thread, then replaces the external provider-thread ref. The session toolset
version makes this migration one-time and auditable.

The task-linked slice exposes one provider portal tool, `task_ledger`, with
typed `inspect`, `create`, and `update` actions. Nucleus validates action
arguments, requires current revisions for updates, routes writes through its
task command boundary, and retains conversation and provider-turn refs on the
task. The provider does not read or write task storage directly.

Agent-facing tools must not mirror each task query or command as a separate
tool. Internal inspection, creation, and update handlers remain separate server
boundaries behind the portal.

Successful calls attach a structured task-authoring receipt to the assistant
message. All successful authoring calls in one turn are consolidated into one
receipt. It survives restart with conversation history and does not replace the
task record or task history.

Task creation and update do not dispatch work or change lifecycle state.
Unsupported callbacks, approvals, and tool names continue to fail closed.
Structured user input, partial streaming deltas, and broader tool activity
projection remain later additions.

An Agent Chat turn may carry one optional active task id from the local
workspace selection. The server must resolve the current task record and
confirm that it belongs to the request project before adding bounded context
to the provider turn. Client-supplied task fields are not authoritative.

Active-task context is focus, not instruction or authority. It does not imply
mutation, assignment, lifecycle change, or dispatch. The canonical user
message remains the operator-authored text; provider-only context enrichment
must not be persisted as if the operator wrote it. The first slice keeps the
selection local and removable rather than creating a durable
conversation-to-task binding.

An explicit operator message may also source a bounded task-workflow mandate.
That mandate is a separate canonical record linked to the conversation, user
message, provider turn, scoped goal id and revision or single task id and
revision, snapshotted task membership, resulting work-item ids, receipts, and
terminal or revocation reason. It stores the cited execution excerpt and scope;
it does not replace or rewrite the user message.

Assistant messages, inferred task readiness, selected-task focus, and task
creation receipts cannot create a mandate. One goal mandate covers its
snapshotted ordered tasks, so contained tasks do not require per-task operator
messages.
