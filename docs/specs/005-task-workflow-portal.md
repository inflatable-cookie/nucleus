# Task Workflow Portal

Status: promoted-first-pass
Owner: Tom
Updated: 2026-07-10

## Purpose

Shape one powerful `task_workflow` portal without projecting Nucleus's internal
delegation, scheduling, dispatch, runtime, lifecycle, and review stages as a
flat agent tool or action menu.

## Portal Boundary

The stable agent-facing tool is `task_workflow`.

Its eventual action families should remain small:

- `inspect`: read workflow position, readiness, active work, blockers, and
  available outcomes for one task or a bounded task set
- `run`: request end-to-end execution of one task or one goal
- `control`: express a runtime intent such as interrupt, resume, cancel, or
  retry without exposing provider-specific commands
- `review`: submit a review or rework intent through the owning server
  admission boundary

These are domain intents. Internal steps such as select adapter, assign,
delegate, schedule, admit dispatch, start provider, transition runtime, record
evidence, or update lifecycle are not separate portal actions.

## First Slice

The first implemented action set should be:

- `inspect`
- `run`

`inspect` returns a product-shaped workflow summary. Detailed artifacts and
validation output belong to the future `work_evidence` portal.

`run` means "make this task execute," not "create an inert scheduling record."
The server must compose readiness, revision checks, route and adapter
resolution, idempotency, work-item admission, provider dispatch, and compact
receipts behind that action. If the current backend cannot complete that chain,
the implementation lane should close the composition gap rather than expose
each intermediate stage to the agent.

Task lifecycle changes caused by admitted workflow events are outcomes of
`run`; they are not separate `start_task`, `mark_active`, or `complete_task`
agent actions. Provider completion remains distinct from review acceptance and
task completion.

## Run Scope

One `run` request may name:

- one task id
- one goal id whose ordered task membership becomes the bounded runway

The server must stop on stale revisions, unresolved dependencies, missing
context, missing validation policy, route failure, conflicting active work, or
an applicable task stop condition. Batch intent does not weaken per-task
admission.

## Authority Options

### A. Conversation mandate

An explicit operator instruction such as "start this task" or "execute this
goal" authorizes the agent to call `run` for that bounded scope.
The operator does not confirm each task separately. Outside that scope, `run`
returns confirmation-required state.

This is the recommended first slice. It is low-UI and supports autonomous
runways without inventing durable project policy.

Selected by the operator on 2026-07-10.

The first goal implementation snapshots the goal revision and at most 50
ordered task ids and revisions when `run` is admitted, executes them serially,
and permits no later scope expansion. Arbitrary task sets and project-wide ready
task sweeps are excluded. The mandate cites the current operator message and an
exact supporting excerpt. It expires when the scope finishes, blocks, is
cancelled, or the operator revokes it.

### B. Durable project autonomy

A project policy allows the agent to dispatch qualifying ready tasks without a
fresh conversation mandate. This needs a visible project-level control, audit
record, concurrency and spend limits, and an emergency stop boundary.

This is a later extension unless the operator wants persistent autonomy now.

### C. Unscoped ready-task autonomy

Any ready task may be dispatched whenever the agent judges it useful. This is
not recommended: task readiness does not by itself grant execution authority,
cost scope, concurrency, or permission for external effects.

## Presentation

Normal chat remains visually unchanged until there is an outcome.

Compact receipts:

- started: task title, agent/route summary, current work state
- confirmation required: concise proposed scope with one confirm action
- blocked: one primary reason with task focus
- stopped: terminal or wait reason

Detailed route selection, idempotency, provider refs, work-item refs, evidence,
and recovery controls remain in the Tasks panel or advanced disclosures.

## Durable Promotion Targets

After the operator selects the run-authority option:

- promote portal action and authority rules into contracts `023` and `024`
- promote the compact interaction into product workflow UI architecture
- compile server composition, portal projection, receipt, and live-validation
  cards

First-pass outcomes are now promoted into contracts `005`, `019`, `023`, and
`024` plus the product workflow UI architecture. This spec remains as planning
history until the first `run` slice closes; canonical authority lives in those
promoted surfaces.
