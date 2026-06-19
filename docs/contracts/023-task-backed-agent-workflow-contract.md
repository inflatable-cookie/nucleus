# 023 Task Backed Agent Workflow Contract

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Define the lifecycle for agent work that is owned by a task.

A task is the planning unit. A task work item is the execution unit that can be
delegated, supervised, reviewed, retried, recovered, or abandoned without
silently completing the parent task.

## Authority Rule

Task-backed work is engine-owned orchestration.

Clients, adapters, desktop panels, native personas, and provider runtimes may
request work or report observations. They must not mark a work item accepted,
complete a task, publish SCM changes, or mutate shared management state without
an admitted command.

## Lifecycle States

Generic work-item runtime states:

- draft: proposed but not ready for admission
- ready: enough task, adapter, policy, and context refs exist for admission
- scheduled: admitted and queued, but no provider/runtime execution has started
- running: runtime work has started
- waiting for approval: runtime is blocked on explicit approval
- waiting for user input: runtime is blocked on user input or clarification
- completed: runtime work ended with a candidate result
- failed: runtime work ended unsuccessfully
- cancelled: work was intentionally stopped
- recovery required: state is incomplete, uncertain, or needs repair before use

Generic review states:

- not ready: no reviewable runtime result exists
- awaiting review: runtime completed and review evidence exists
- accepted: operator accepted the work item result
- rejected: operator rejected the result
- needs changes: operator requested rework
- abandoned: operator closed the work item without accepting it

Runtime completion and review acceptance are separate. Accepted work and task
completion are also separate unless a later task-domain policy admits the task
completion command.

## Transition Rule

Allowed first-pass runtime transitions:

- draft -> ready
- ready -> scheduled
- scheduled -> running
- running -> waiting for approval
- running -> waiting for user input
- running -> completed
- running -> failed
- running -> cancelled
- waiting for approval -> running
- waiting for approval -> cancelled
- waiting for approval -> failed
- waiting for user input -> running
- waiting for user input -> cancelled
- waiting for user input -> failed
- failed -> recovery required
- cancelled -> recovery required
- recovery required -> ready
- recovery required -> abandoned through review when evidence is sufficient

Allowed first-pass review transitions:

- not ready -> awaiting review
- awaiting review -> accepted
- awaiting review -> rejected
- awaiting review -> needs changes
- awaiting review -> abandoned
- needs changes -> ready through a new or repaired work item
- rejected -> ready through a new or repaired work item

Invalid transitions must fail closed. In particular:

- provider completion must not jump directly to task completion
- provider completion must not imply review acceptance
- approval wait must not be treated as failure
- user-input wait must not be treated as success
- cancellation must not imply rollback
- recovery must not silently reuse an uncertain provider session

## Evidence Rule

A work item links to evidence by reference.

Allowed first-pass refs:

- agent session id
- provider runtime/session refs
- turn ids
- runtime receipt ids
- checkpoint ids
- diff summary ids
- task timeline entry ids
- validation refs
- artifact refs
- SCM work-session refs
- provider-neutral change refs

Work-item records and projections must not copy full provider transcripts,
terminal streams, raw stdout/stderr, raw tool payloads, secrets, or credential
material by default.

## Projection Policy

Task-backed workflow state has two different persistence roles.

Authoritative local/server state:

- task-agent work-unit source records
- runtime receipts
- checkpoint and diff summary refs
- review decisions and task timeline events
- provider session, turn, callback, interruption, and recovery refs

Repo-backed management projections:

- task summaries suitable for collaboration
- accepted planning metadata
- task readiness and review summaries
- stable evidence refs, not evidence payloads

Repo-backed projections are shareable coordination artifacts. They are not the
authority for live runtime state, provider sessions, local client layout,
credential material, raw output, or review acceptance. If a projection is stale
or missing, the server rebuilds it from authoritative state or records a repair
proposal; it must not import projection files as live task-agent state.

## Codex Binding Rule

Codex app-server integration is one runtime binding, not the generic model.

Codex-specific refs may include:

- provider instance id
- Codex session id
- Codex thread id
- Codex turn id
- Codex item id
- approval request id
- structured user-input request id
- transport sequence
- unsupported observation ref

Nucleus-owned ids remain authoritative for task, work item, session, turn,
timeline, receipt, checkpoint, and review state. Codex ids are external refs
with mapping confidence.

Codex event ingestion may move a work item through running, waiting,
completed, failed, cancelled, or recovery-required states only through
admitted orchestration events. Unsupported Codex methods become diagnostics or
repair evidence, not silent state changes.

Codex approval and user-input callbacks must preserve the original provider
request refs. A timeout or local cancellation must create explicit receipt or
recovery evidence.

## Review Rule

Review works on Nucleus evidence, not provider status alone.

To enter awaiting review, a work item needs:

- completed runtime state
- at least one validation ref, checkpoint id, diff summary id, receipt id, or
  explicit no-change evidence ref
- a sanitized summary suitable for client display

To accept, reject, request changes, or abandon, the reviewer command must name:

- reviewer ref
- work item id
- expected current state or revision where available
- outcome
- evidence refs
- note or reason when the outcome is reject, needs changes, or abandon

Rework creates a new work item or a repaired work item with provenance back to
the prior one. It must not overwrite prior runtime or review evidence.

## Implementation Gap Review

Current engine proof records already have useful shape:

- `EngineTaskWorkItemRecord` separates runtime and review state
- runtime refs are reference-only
- review transitions require completed runtime plus evidence
- review acceptance does not complete the parent task
- projections summarize linked evidence without copying raw runtime streams
- task-agent progress DTOs are read-only and expose mutation/provider
  execution authority as explicit `false` fields
- source-record projections are deterministic only when cursor ordering is
  stable and monotonic inside a work item

Missing or incomplete surfaces before runtime implementation:

- provider-runtime binding record for Codex session/thread/turn/item refs
- wait-state records for approval and user input
- recovery record for interrupted, unsupported, partial, or uncertain sessions
- timeline mapping for work-item lifecycle events beyond task command summaries
- idempotency and expected-revision rules for review and rework commands
- broader task-agent transition validation after live provider observations
  start entering the orchestration event store

These gaps are assigned to the next implementation runway. They do not block
the contract reset.

## 2026-06-19 Rebaseline

Current Codex task runtime code can admit a task-scoped request into the inert
scheduler, project fixture-backed runtime observations into progress records,
link sanitized receipts, route wait states, and classify unsupported or failed
observations.

It cannot yet move task work-item runtime state from live provider events.
That requires:

- durable provider session binding
- accepted provider event records in the orchestration event store
- idempotent frame/event ingestion
- receipt linkage for wait, cancellation, failure, and completion outcomes
- admitted state-transition commands or events owned by the engine

The next lane should implement those records before provider callbacks,
provider-reaching cancellation, or automatic task state mutation.

## 2026-06-19 Hardening Update

The server now persists task-agent work-unit source records as sanitized
task-history records. Task work progress and task-agent diagnostics read from
those source records. The write path rejects raw provider material and validates
first-pass runtime/review transitions before persistence.

This closes the proof-only in-memory progress path. It does not authorize live
provider writes, provider callbacks, provider-reaching cancellation, resume, or
automatic task mutation.

## Relationship To Other Contracts

- `002-harness-adapter-contract.md` owns adapter capability differences.
- `005-task-contract.md` owns task fields and task history summaries.
- `018-orchestration-contract.md` owns command, event, projection, and replay
  rules.
- `019-conversation-timeline-contract.md` owns canonical timeline identity.
- `020-runtime-receipt-contract.md` owns runtime receipts and wait evidence.
- `021-checkpoint-diff-contract.md` owns review evidence boundaries.
