# Task Project Workflow Gap Matrix

Status: draft
Owner: Tom
Updated: 2026-06-23

## Purpose

Map the current task/project workflow implementation to the promoted
contracts, then choose the next bounded product slice.

This matrix is implementation evidence. It does not authorize task mutation,
provider execution, SCM/forge mutation, scoring policy, goal-loop execution, or
final UI work.

## Governing Refs

- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Implemented Surfaces

### Project Identity

Code:

- `crates/nucleus-projects/src/lib.rs`
- `crates/nucleus-projects/src/projection.rs`
- `crates/nucleus-projects/src/storage_codec.rs`
- `crates/nucleus-server/src/project_seed.rs`
- `crates/nucleus-server/src/request_handler/tests/project_queries.rs`

Implemented:

- durable project ids
- project status
- importance baseline
- repo membership records
- repo path history
- repo repair actions
- project storage codec
- project projection records
- local project seed and query path

Missing:

- project authority-map persistence
- repo repair command flow
- project activity scoring
- multi-host authority update flow
- planning, memory, and task refs as fully connected server records

### Task Records

Code:

- `crates/nucleus-tasks/src/lib.rs`
- `crates/nucleus-tasks/src/assignment.rs`
- `crates/nucleus-tasks/src/history.rs`
- `crates/nucleus-tasks/src/preferences.rs`
- `crates/nucleus-tasks/src/projection.rs`
- `crates/nucleus-tasks/src/storage_codec.rs`
- `crates/nucleus-server/src/task_seed.rs`

Implemented:

- stable task ids
- project ids
- title, description, acceptance criteria
- importance and neglect fields
- action type taxonomy
- assignment state and assignment plans
- activity states
- agent-readiness fields
- task history, validation, handoff, and model preference records
- committable task projection records
- storage codec and local seed path

Missing:

- planning artifact refs on the main task struct
- shared memory refs on the main task struct
- first-class task seed promotion
- durable task priority queue
- contracted scoring or decay policy

### Task Commands

Code:

- `crates/nucleus-engine/src/task_commands/model.rs`
- `crates/nucleus-engine/src/task_commands/service.rs`
- `crates/nucleus-engine/src/task_commands/helpers.rs`
- `crates/nucleus-engine/src/task_commands/tests.rs`
- `crates/nucleus-server/src/request_handler/task_commands.rs`
- `crates/nucleus-server/src/request_handler/tests/task_authoring.rs`
- `crates/nucleus-server/src/request_handler/tests/task_transitions.rs`

Implemented:

- create, update, delegate, start, block, complete, and archive command model
- revision checks for updates and transitions
- project-exists validation for creation
- agent-readiness validation
- delegation admission that creates scheduled work-item records without
  starting provider execution
- control handler tests for task authoring and transitions

Risk:

- task command behavior exists, but the next lane should stay read-only unless
  it explicitly chooses a command hardening slice.

### Task Work Items And Review

Code:

- `crates/nucleus-engine/src/task_work_items.rs`
- `crates/nucleus-engine/src/task_work_items/types.rs`
- `crates/nucleus-engine/src/task_work_items/runtime_projection.rs`
- `crates/nucleus-engine/src/task_work_items/review.rs`
- `crates/nucleus-engine/src/task_work_items/tests.rs`
- `crates/nucleus-engine/src/task_agent.rs`
- `crates/nucleus-engine/src/task_agent/types.rs`
- `crates/nucleus-engine/src/task_agent/admission.rs`
- `crates/nucleus-engine/src/task_agent/projection.rs`
- `crates/nucleus-engine/src/task_agent/diagnostics.rs`
- `crates/nucleus-server/src/task_agent_work_unit_state/`
- `crates/nucleus-server/src/request_handler/tests/task_work_progress_query.rs`

Implemented:

- work items as separate execution units
- runtime state separate from review state
- reference-only runtime evidence
- deterministic runtime projections
- review decisions that do not complete parent tasks
- work-unit source persistence
- read-only task work progress query and DTO

Missing:

- persisted work-item repository as a first-class query source
- next-task candidate projection over task records plus work-item state
- rework path that creates a new or repaired work item from review outcome
- complete task timeline coverage for work-item lifecycle events

### Runtime And Provider Linkage

Code:

- `crates/nucleus-server/src/codex_task_runtime/types.rs`
- `crates/nucleus-server/src/codex_task_runtime/*.rs`
- `crates/nucleus-server/src/provider_live_evidence_task_state_*`
- `crates/nucleus-server/src/provider_live_evidence_task_completion_*`

Implemented:

- Codex task runtime request records
- provider refs kept outside generic work-item model
- wait links for approval and user input
- recovery gates
- progress events
- runtime receipt links
- error classification records
- live-evidence task completion and state-transition surfaces

Missing:

- provider-neutral task runtime readiness projection
- canonical pathway from runtime progress to next-task candidate selection
- task-owned recovery queue surfaced as a product read model

### Task Timeline

Code:

- `crates/nucleus-engine/src/task_timeline.rs`
- `crates/nucleus-server/src/request_handler/queries/task_timeline.rs`
- `crates/nucleus-server/src/control_envelope_dto/query.rs`
- `crates/nucleus-server/src/control_envelope_dto/response/records/timeline.rs`
- `apps/nucleusd/src/query.rs`
- `apps/nucleusd/src/query/typed_response/task_authority.rs`

Implemented:

- task-scoped deterministic timeline projection from command-admitted events
- server query path
- serialized control-envelope request and response DTOs
- `nucleusd query task-timeline --task <task-id>`
- root Effigy selector

Known limitation:

- task creation events are project-scoped and do not appear in the first
  task-scoped projection until later task events target the concrete task id.

### Structured Planning

Code:

- `crates/nucleus-server/src/task_seed.rs`

Implemented:

- local bootstrap task seed only

Missing:

- planning session records
- planning artifact records
- task seed groups
- task seed review and promotion
- deep research linkage
- accepted planning artifact projection

## Selected First Slice

Build a deterministic read-only task readiness candidate projection.

The projection should classify task records into a small number of candidate
states using existing fields and evidence only:

- ready for human planning
- ready for agent delegation
- active work present
- awaiting review
- blocked
- repair required
- completed or archived

The first slice should not rank tasks with a numeric score. It should expose a
stable candidate list and explanatory reasons. A later scoring contract can add
importance, neglect, goal, and project priority ordering.

## Why This Slice

- It follows directly from the next-task contract without inventing a next task.
- It uses current task fields, activity states, agent-readiness fields,
  work-item review state, and task timeline evidence.
- It supports the product loop more than another provider-readiness panel.
- It can be exposed through server query, control DTO, `nucleusd`, and Effigy
  without provider execution or UI design.

## Non Goals

- task mutation
- task creation or update commands
- provider execution
- SCM/forge mutation
- scoring, decay, or automatic priority ranking
- goal record implementation
- autonomous loop execution
- structured planning session implementation
- desktop UI design
- raw provider payload or terminal stream retention

## Implementation Notes

Preferred shape:

- keep domain classification logic in `nucleus-engine` or `nucleus-tasks`
- keep server query composition in `nucleus-server`
- keep DTO mapping in focused `control_envelope_dto` modules
- keep CLI rendering in focused `apps/nucleusd/src/query` helpers
- add Effigy selector only after CLI shape is stable

Candidate query shape:

```text
nucleusd query task-readiness --project <project-id>
```

Candidate server query result:

- project id
- candidate records
- status counts
- blocker counts
- source counts
- `client_can_mutate = false`
- `provider_execution_available = false`

Candidate record:

- task id
- title
- activity
- action type
- readiness class
- reasons
- blocker refs
- evidence refs
- agent-ready flag
- validation command refs

## Planning Gaps

- final scoring/priority policy belongs in a future contract delta
- goal domain and storage records are implemented; query, command, portal, and
  UI surfaces remain pending
- structured planning artifact refs are not implemented in task records
- work-item persistence is partial and should be treated as optional evidence
  for the first projection
- authority-map persistence remains deferred, so the projection should not
  claim mutation authority

## Implementation Progress

Completed:

- `crates/nucleus-engine/src/task_readiness.rs` implements deterministic
  project-scoped candidate classification, reasons, blockers, evidence refs,
  status counts, source counts, and explicit no-effect flags.
- `nucleus-server` composes the projection from stored task records through
  `ServerQueryKind::TaskReadiness`.
- serialized control DTOs, `nucleusd query task-readiness --project
  <project-id>`, and `effigy server:query:task-readiness` expose the read-only
  projection.

Remaining:

- validation closeout
- next lane selection
