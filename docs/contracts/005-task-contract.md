# 005 Task Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the durable task model for project planning and agent-ready work.

Tasks are first-class records. They are not loose checklist items and should
carry enough context for a human or agent to understand scope, acceptance, and
validation.

Task records should be project-portable where possible. Shared task intent may
be projected into repo-backed files so cloned projects can carry their task
state without requiring a hosted Nucleus database.

## Task Identity

Each task must expose:

- stable task id
- project id
- title
- description
- acceptance criteria
- importance
- staleness or neglect signal
- action type
- assignment state
- activity state
- agent-readiness fields
- assignment plan
- assignment snapshot
- task history
- model preferences
- shared memory refs
- planning artifact refs
- timestamps

## Action Types

Initial action types:

- research
- plan
- execute
- test
- check
- review

These are coarse task intents. They should guide routing and validation without
pretending every agent workflow is identical.

## Importance And Neglect

Task importance and project importance combine in future prioritisation.

The first model only records coarse task importance and neglect state. It does
not implement scoring, decay, ranking, or scheduling.

Unknown scoring policy must not leak into arbitrary numeric fields before the
prioritisation contract exists.

## Assignment State

A task may be:

- unassigned
- assigned to a human
- assigned to an agent
- mixed across more than one actor

Assignment state does not mean execution has started. Activity state records
whether the task is proposed, ready, active, blocked, done, or archived.

## Agent Assignment Rule

Agent assignment is a planning decision before execution begins.

An assignment plan must identify:

- task id
- assignment target
- required context references
- capability requirements
- model preferences
- assignment audit entries

Initial assignment targets:

- human
- explicit agent
- explicit adapter instance
- best available agent
- mixed actors

Choosing only a provider driver kind is not a valid assignment target. Agent
assignment must resolve to a configured adapter instance before work begins.

Assignment status is separate from task activity. Initial assignment statuses
are pending selection, assigned, in progress, interrupted, released, and
complete.

Interrupted work must preserve the selected adapter instance, selected route,
selected session when known, and enough audit history for later recovery or
human review. This is not an execution log.

## Task History Rule

Task history is durable task state. It is not a UI activity log and must not
duplicate runtime event streams.

Low-volume task history summaries may be projected to the management
repository. High-volume runtime streams, provider transcripts, and raw
validation output should be linked by reference unless an explicit artifact
policy says otherwise.

Task history entries must identify:

- history entry id
- task id
- timestamp when known
- actor
- event
- optional note

Initial task history events:

- created
- updated
- assignment changed
- agent attempt started
- agent attempt interrupted
- agent attempt failed
- agent attempt completed
- handoff
- validation recorded
- blocked
- released

Agent attempt records must preserve:

- attempt id
- assignment target
- adapter instance reference
- route reference when selected
- session id when known
- runtime event references

Agent attempt summaries must preserve outcome, adapter instance, route,
session, validation references, runtime event references, and a short summary.
They must not copy full provider transcripts or runtime event streams.

Validation evidence belongs on the task only as command, status, evidence
references, and summary. Raw command output should be stored as an artifact or
journal reference when needed, not copied into task history by default.

Validation commands are command execution requests. Task readiness may name
intended validation commands, but execution must go through server command
policy.

When a project has Effigy enabled, task readiness may name Effigy selectors
for setup, validation, health checks, or release gates. Selector refs are
workflow hints and evidence links. They must not replace acceptance criteria
or command authority.

Task records may retain sanitized command evidence refs and summaries. They
must not copy raw stdout, raw stderr, terminal streams, shell traces, secret
values, or provider credential output by default.

Human handoffs and reassignment must record source actor, target actor, reason,
and context references.

## SCM And Forge Task Links

Tasks may link to SCM and forge objects by reference.

Allowed first-pass link targets:

- branch
- commit
- provider-neutral SCM change
- SCM work session
- SCM conflict
- review workflow
- pull request or merge request
- issue
- comment

Task links do not replace task identity. Forge issue ids, pull request ids, and
SCM change ids remain external references.

Task links may be:

- user-authored
- adapter-observed
- steward-suggested
- imported

Adapter-observed links are evidence until accepted or promoted. They should
not mutate projected task state by themselves.

Task link status should be explicit. Stale, missing, superseded, and unknown
links should be retained until a human, policy, or later repair flow removes or
updates them.

SCM and forge observations may propose low-volume task history summaries, but
they must not become task history automatically. A task-domain action must
decide which observation summaries belong in durable task history.

## SCM Work Session Binding

A task or agent attempt may bind to an SCM work session.

The binding may reference:

- primary worktree branch session
- per-thread worktree session
- external managed session
- review request or merge target
- conflict record
- review workflow record

The task remains the planning unit. The SCM work session is execution context.
It must not replace task identity, assignment state, activity state, or
acceptance criteria.

Task assignment UI should surface whether an agent will work in the primary
checkout or in a separate worktree. If the project has a single runnable
instance constraint, Nucleus must make that constraint visible before launching
parallel work.

Review workflows and conflict records may add task history summaries by task
action. They must not update task status, acceptance criteria, assignment
state, or activity state automatically.

Rejected or abandoned review work should remain linkable from the task until a
human, policy, or repair flow marks it stale, superseded, or safe to remove.

## Task Projection Record

Committed task state lives under:

```text
nucleus/tasks/<task-id>.toml
```

One task per file is the first-pass rule. Large shared task documents are not
the initial model because they create poor Git conflict surfaces.

The task projection record should include:

- schema version
- stable task id
- project id
- title
- description
- acceptance criteria
- importance
- action type
- workflow activity state
- assignment intent
- agent-readiness summary
- validation summary refs
- artifact refs
- low-volume task history summaries
- updated timestamp or record revision where known

The task projection record must not include:

- live runtime event streams
- full provider transcripts
- raw validation output by default
- terminal or browser state
- provider auth material
- secrets
- local cache paths

Agent attempt records may be summarized by reference. Full runtime records stay
server-local or artifact-backed unless an explicit import policy says
otherwise.

## Task Model Preferences

Task model preferences influence adapter and route selection without mutating
project, session, adapter, or route defaults.

Initial preference modes:

- no preference
- prefer listed routes
- require one of listed routes
- inherit project default
- inherit session default

Task route preferences may include route reference, coarse weight, and reason.
Initial weights are low, normal, high, and required.

Task-level scoped route overrides are selection inputs. They must not become
durable route config unless a later explicit action promotes them to project or
session scope.

Task action type may derive capability requirements. For example, execute, test,
check, and review tasks may need different adapter capabilities. The task
contract names the requirement; it does not implement mapping or scheduling.

## Agent Readiness

Agent-readiness fields must cover:

- whether the task is ready for agent delegation
- required context references
- allowed action types
- stop conditions
- validation commands

A task should not be one-click delegated unless the readiness fields are clear
enough for the selected agent and harness.

## Task Mutation Semantics

Task mutation is server-owned state behavior.

The first executable mutation subset should be task activity transitions
against existing task records:

- start
- block with reason
- complete
- archive

These commands may update activity state only:

- start sets activity to active
- block sets activity to blocked with the supplied reason
- complete sets activity to done
- archive sets activity to archived

Create and update now have a first server-owned command path. The path uses
task authoring input, writes storage through the server state service, and
returns read-after-write state through the typed task DTO boundary.

State transitions must:

- require an existing task record
- preserve task id, project id, title, description, acceptance criteria,
  importance, action type, assignment intent, and agent-readiness flag
- update the stored record through the server state service
- produce read-after-write visibility through the typed task DTO boundary
- return not-found when the task record is missing
- return conflict when an exact revision expectation is supplied and does not
  match

Server-internal bootstrap or repair paths may use `MustExist` when the current
revision is not exposed to a client action. Client-originated task mutations
should use exact revision checks once command DTOs expose revision ids.

Task mutation is not runtime execution. Starting a task does not start an
agent session, checkout a branch, run validation, or claim assignment.

Create commands must:

- require an existing project record
- generate the task id on the server side
- reject empty or oversized titles
- reject done or archived initial activity
- reject agent-ready tasks without acceptance criteria
- write one task storage record

Update commands must:

- require an existing task record
- use exact revision checks when an expected revision is supplied
- apply replacement values only for supplied editable fields
- preserve omitted fields
- reject empty or oversized titles
- reject agent-ready tasks without acceptance criteria
- preserve task id and project id

## Task Authoring Input

Task authoring input is the client-to-server shape for creating and editing
task intent. It is not the display DTO and it is not the full storage record.

The first editable input shape should include:

- project id
- title
- description
- acceptance criteria
- importance
- action type
- initial or edited activity state
- agent-readiness flag
- required context references
- stop conditions
- validation command refs
- optional model preference refs
- optional SCM or forge links

Create input must require:

- project id
- non-empty title
- action type
- importance
- activity state of proposed, ready, or active

Update input must require:

- task id
- expected revision when the task came from a client-visible record
- editable fields to replace

The first update model is replacement-by-field, not patch-by-arbitrary-path.
Clients may omit fields they are not editing. Arrays supplied by the client
replace the previous array for that field.

Editable fields in the first authoring model:

- title
- description
- acceptance criteria
- importance
- action type
- activity state
- agent-readiness flag
- required context references
- stop conditions
- validation command refs
- model preference refs
- SCM or forge links authored by the user

Server-owned fields:

- stable task id generation on create
- project existence validation
- schema version
- storage revision
- timestamps
- task history entries
- adapter-observed links until promoted
- assignment snapshots
- agent attempt records
- runtime event refs
- command evidence refs
- projection path

Validation rules:

- title must be trimmed, non-empty, and short enough for list rendering
- project id must reference an existing project record
- action type must be one of research, plan, execute, test, check, or review
- importance must stay inside the task importance vocabulary
- activity state on create must not be done or archived
- blocked activity requires a non-empty reason
- done and archived states should normally be reached through transition
  commands, not create forms
- acceptance criteria may be empty for draft/proposed tasks, but agent-ready
  tasks should have at least one clear acceptance item
- validation command refs must be references or selectors, not raw shell output
- required context refs must point to known project docs, repo paths, artifacts,
  memories, or external links
- model preference refs must not create new route config by themselves

Task authoring must not accept:

- raw provider transcripts
- raw terminal streams
- raw stdout or stderr
- secret values
- provider credentials
- local cache paths
- arbitrary storage revision ids
- task history entries authored directly by clients

Create and update commands should return read-after-write task records through
the typed task DTO boundary. The server may add task history summaries for
create or update, but clients do not submit task history directly.

## Planning And Memory Links

Tasks may link to accepted shared memories and planning artifacts by reference.

Allowed first-pass refs:

- accepted project memory
- accepted task memory
- accepted planning artifact
- task seed source
- decision record
- open question set

Task links to memories and planning artifacts provide context. They must not
replace task title, description, acceptance criteria, assignment state, or
activity state.

Proposed memories and draft planning artifacts may be used as evidence during
task preparation, but they should not become required task context until
accepted or explicitly attached.

## Current Rust Surface

`nucleus-tasks` now contains the first draft of:

- `TaskId`
- `Task`
- `AcceptanceCriterion`
- `TaskImportance`
- `NeglectSignal`
- `NeglectLevel`
- `TaskActionType`
- `AssignmentState`
- `TaskActivityState`
- `AgentReadiness`
- `TaskAssignmentPlan`
- `TaskAssignmentTarget`
- `TaskCapabilityRequirement`
- `TaskAssignmentAuditEntry`
- `TaskAssignmentAuditEvent`
- `TaskAssignmentSnapshot`
- `TaskAssignmentStatus`
- `TaskHistoryEntry`
- `TaskHistoryEntryId`
- `TaskHistoryActor`
- `TaskHistoryEvent`
- `AgentAttemptRecord`
- `AgentAttemptId`
- `AgentAttemptSummary`
- `AgentAttemptOutcome`
- `TaskHandoffRecord`
- `TaskValidationRecord`
- `TaskValidationStatus`
- `TaskModelPreferences`
- `TaskModelPreferenceMode`
- `TaskRoutePreference`
- `TaskPreferenceWeight`
- `TaskTimestamps`
- `TaskProjectionRecord`
- `TaskProjectionHistorySummary`
- `TaskStorageRecord`
- `TaskStorageAcceptanceCriterion`
- `TaskStorageImportance`
- `TaskStorageActionType`
- `TaskStorageActivityState`
- `task_from_storage_record`

These are descriptive domain and storage projection types only. Scheduling,
scoring, adapter selection, assignment execution, agent delegation, projection
IO, runtime records, provider transcripts, and command evidence remain out of
scope for task storage.

## Research Gaps

- Exact importance and staleness scoring policy.
- How task ranking combines project baseline, task importance, and inactivity.
- How validation commands bind to harness sessions and repo worktrees.
- Exact action-type to adapter-capability mapping.
- Artifact reference policy for retained validation output.
- Mapping task validation commands to command authority scopes.
- Mapping task validation and health checks to Effigy selectors where enabled.
