# Product Workflow UI Architecture

Status: draft
Owner: Tom
Updated: 2026-07-07

## Purpose

Define the first real product workflow UI direction before more server surfaces
are added to disposable proof panels.

The disposable desktop proof has served its integration role. It should remain
available as a diagnostic harness, but it must stop growing into a catch-all UI
surface.

## Decision

Freeze the current `TaskWorkflowDrilldownProofPanel` as diagnostic-only.

The next UI work should design a chat-led, task-backed workflow. The primary
interface is AI agent conversation. Tasks are the structured work ledger behind
that conversation and can be created, updated, and dispatched by agents through
server-authorized tools or skills.

The user should be able to move through a full problem-shaping and task
dispatch flow without opening the task panel at all. The task panel exists for
explicit inspection, triage, and manual control when useful.

The real product workflow should match how users will move through Nucleus:

- choose project
- talk through a problem with an agent
- let the agent create or update tasks when structure is useful
- inspect task context only when the user wants explicit control
- let the agent or user dispatch tasks when ready
- keep the agent in the loop as tasks run
- watch evidence
- review results
- request rework or complete the task
- hand off to SCM/forge when appropriate

The UI should consume server-owned state. It must not become authority for
task, work-item, provider, memory, planning, SCM, or forge state.

## Current Proof UI Boundary

The proof modal may remain as:

- integration diagnostics
- DTO smoke-test surface
- read-only server state inspector
- temporary manual verification tool

The proof modal must not:

- absorb new product controls by default
- become the primary selected-task workflow
- define final layout, navigation, information hierarchy, or interaction copy
- hide missing workflow design by stacking more cards
- duplicate server logic in Svelte

Any new proof-only addition now needs a clear reason. The default should be to
shape the real workflow surface first.

## First Product Workflow Surface

The first real surface should be chat-centered, project-aware, and task-backed.

The task view must not be the primary interface by default. It is a persistent
ledger and control surface behind the chat-led workflow.

Primary regions:

- project rail: project switching, activity, server/host context
- centerTop: primary agent chat and primary workspace panels
- centerBottom: secondary workspace panels, including terminal/browser/editor
  panels or the task panel when the user moves it down
- right: contextual inspector, action affordances, review, logs, output, and
  evidence details tied to the active work
- task panel: uncloseable system tab, defaulted to centerTop and only movable
  to centerBottom in the first model

Initial interaction order:

1. User selects a project.
2. User talks to an agent.
3. Agent helps shape the work and creates or updates tasks when needed.
4. Agent or user dispatches one bounded task when ready.
5. UI keeps active task/thread state visible without forcing the task panel to
   become the main screen.
6. User can open or focus the task panel for explicit inspection or manual
   dispatch.
7. UI shows blockers and missing evidence before offering action controls.
8. User previews or applies one admitted command.
9. UI refreshes server state and shows resulting evidence.
10. Review/rework/completion actions become available only through server
   admission.

## Workspace Hosting Prerequisite

The selected-task workflow shell should not become a one-window-only layout
model. Before serious product shell implementation, Nucleus should promote the
already-recorded Loophole-inspired hosting hierarchy into
`nucleus-workspaces`:

```text
display -> window -> surface -> region -> panel
```

The transferable part from Loophole is the hosting model, not the DAW panel
defaults. Nucleus needs:

- global local client profile records for displays, windows, hosted surfaces,
  surface ordering, and active-surface fallback
- per-project local panel rules that adapt into the global shell
- renderer-owned transient drag, hover, focus, and measurement only
- server-owned resource refs for terminals, browsers, agent sessions, editor
  buffers, SCM state, evidence, review, and task state

This means the first real selected-task UI should be designed as a panel set
that can live inside a hosted surface, not as the whole workspace authority.
Desktop can start with one native window and one hosted surface, but the model
must leave room for multiple windows and surfaces without rewriting identity or
persistence later.

Hosted surfaces use the Loophole-style surface tab strip at window level.
Surfaces are global client-profile containers and must support multi-display
and multi-window placement with deterministic fallback to primary windows when
displays are unavailable.

The first desktop implementation persists the local surface shell at
`~/.nucleus/config/ui.json`. This is a pragmatic bring-up file for local UI
state. It must not be projected into project repositories, and it can be
migrated into a richer local client store later.

Within a surface, the initial region vocabulary is fixed to `left`, `right`,
`centerTop`, and `centerBottom`. There is no generic bottom region. Terminals,
browsers, editors, diffs, chats, and task views are primary workspace furniture
and belong in `centerTop` or `centerBottom`. Contextual logs/output belong
inside their owning panel or in `right`.

Implementation should inspect Loophole's current Echo crates before coding:

- `../loophole/echo/crates/echo-windowing`
- `../loophole/echo/crates/echo-ui-layout`

The initial Nucleus implementation should port or recreate the Rust model in
small `nucleus-workspaces` modules before porting any Aura configuration UI.

## Server Surface Fit

Existing server surfaces are useful, but they were produced proof-first. Before
more product controls are built, the UI lane should decide:

- which read models are directly product-facing
- which read models remain diagnostics
- which DTOs need aggregation to avoid many client round trips
- which control actions belong in task context or workflow panels
- which controls belong in specialist panels
- where mutation/admission previews end and apply commands begin

The UI should prefer product-shaped aggregate queries over many small proof
queries when the same screen always needs them together.

## Disposable Proof Debt

Known proof debt:

- `TaskWorkflowDrilldownProofPanel.svelte` is too large.
- It mixes workflow overview, review, route, rework, SCM readiness, command
  admission, task command execution, and evidence display.
- It is useful for smoke checks but not a maintainable product component.
- It should not receive delegation scheduling UI unless a very narrow
  diagnostic reason exists.

Required cleanup before final UI:

- split proof-only DTO helpers from product client helpers where useful
- move final UI components into separate product workflow modules
- keep proof routes/modal optional and isolated
- prevent proof CSS from becoming product design precedent

## Proof Versus Product Classification

Diagnostic-only proof sections:

- protocol envelope smoke details
- no-effect flag dumps
- raw DTO shape checks
- individual control-query fallback messages
- command admission debug receipts
- per-surface source-count chips
- route/refusal internals that are not useful as primary user copy

Product workflow concepts that should graduate:

- selected project and selected task context
- agent-led task creation, refinement, and dispatch
- one primary next action
- readiness and blockers
- task command admission and apply state
- work-item list and current work state
- evidence timeline
- review decision controls
- rework request summary
- completion readiness
- SCM handoff readiness

The product UI should translate server records into user-facing workflow
language. It should not expose every server proof field just because the field
exists.

## Product Surface Fit Decision

The proof modal currently composes many narrow queries because each proof lane
validated one boundary at a time. That was useful for server confidence, but it
is the wrong client shape for the product shell.

Product-facing selected-task UI should consume a selected-task workflow
aggregate that gives the shell one coherent read model:

- project/task identity and task state
- primary next action and reason
- readiness, blockers, and unavailable actions
- admitted command previews and apply state
- current work items and evidence summary
- review next step and review decision availability
- rework preparation summary
- completion route preview
- SCM handoff readiness

The existing narrow query surfaces should remain diagnostic-only unless a
specialist panel needs the detail. Now that the first project shell is in
place, the selected-task aggregate is available as a product data boundary, but
it should not be rendered into the normal workspace until the chat-led workflow
shape says where task state belongs.

Delegation scheduling remains paused until the selected-task shell and
workspace hosting model can present it without expanding the proof modal.

## Selected-Task Aggregate Shape

The selected-task aggregate is the product shell's workflow read model.

It is not the primary navigation model. Chat remains primary. The aggregate
supports panels that need task workflow state after the user or agent is already
working against a task.

It should be product-shaped:

- one selected project/task identity group
- one primary next action with a reason
- readiness, blocker, and unavailable-action groups
- compact work/evidence/review/rework/completion/SCM handoff summaries
- source-health refs so the UI can show missing or stale state honestly

It should not be proof-shaped:

- no raw DTO dump
- no per-query debug widgets
- no proof-modal source-count chips as primary UI
- no client-side action authority

The canonical behavioral contract is
`docs/contracts/023-task-backed-agent-workflow-contract.md`.

## Open Decisions

- Exact `nucleus-workspaces` port shape for Echo windowing and UI layout
  concepts.
- Which Poodle components need extension before building the workflow shell.

## Initial Agent Chat Slice

Operator direction keeps the approved workspace surface shell intact. The
first real workflow is implemented inside the existing Agent Chat panel.

The first slice uses a server-owned local Codex app-server process and retains
one provider thread per Agent Chat panel while the desktop is open. The server
resolves the project working directory from project state. The client sends a
project id, panel conversation id, and message; it does not select an arbitrary
working directory.

This bring-up slice is intentionally narrower than the canonical conversation
target:

- user and assistant messages are retained in client memory for panel remounts
- Nucleus session, turn, and message records are not durable yet
- provider thread restart recovery is not claimed
- provider callbacks, approvals, structured user input, and task linkage are
  deferred
- the provider runs with read-only workspace access and no approval escalation

The next product decision follows visual and workflow review of the live chat.
Durable timeline projection, streaming presentation, and task context must not
be added together by default.
