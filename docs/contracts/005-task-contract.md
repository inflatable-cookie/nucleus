# 005 Task Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the durable task model for project planning and agent-ready work.

Tasks are first-class records. They are not loose checklist items and should
carry enough context for a human or agent to understand scope, acceptance, and
validation.

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

Human handoffs and reassignment must record source actor, target actor, reason,
and context references.

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

These are descriptive domain types only. Scheduling, scoring, adapter
selection, assignment execution, and agent delegation remain out of scope.

## Research Gaps

- Exact importance and staleness scoring policy.
- How task ranking combines project baseline, task importance, and inactivity.
- How validation commands bind to harness sessions and repo worktrees.
- Exact action-type to adapter-capability mapping.
- Artifact reference policy for retained validation output.

## Next Task

Draft validation evidence and artifact reference semantics.
