# Product Workflow UI Architecture

Status: draft
Owner: Tom
Updated: 2026-07-10

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

The accepted chat interaction now has first-pass durable continuity:

- Nucleus session, turn, and ordered user/assistant message records persist in
  server-owned local state
- the panel hydrates from server history after remount or desktop restart
- the provider thread id is retained as an external ref and resumed after
  local service restart
- a mismatched replacement provider thread fails instead of silently changing
  conversation identity
- unsupported callbacks, approvals, and structured user input remain deferred
- the provider runs with read-only workspace access and no approval escalation

The first task interaction inside Agent Chat is agent-authored task creation.
The agent may create one standalone task or a Goal with a longer task runway
when intent is clear, using a server-authorized dynamic tool. A tool call
produces one compact durable receipt and refreshes the task panel. Detailed
inspection and manual control stay in the task panel.

Task proposal cards remain useful when conversation intent or scope is
materially ambiguous. They are not the default admission step for every task.
Creating a task never dispatches it. Streaming presentation remains deferred.

## Initial Tasks Panel

The system Tasks tab in the approved workspace shell hosts the first proper
task UI. It uses the existing server task-record query rather than the proof
harness composition.

The first layout is deliberately narrow:

- a project-filtered task list with title, activity, action type, and readiness
- one selected-task detail view with description and acceptance criteria
- importance, assignment, and readiness as compact facts
- context refs, allowed actions, stop conditions, validation, and task id under
  one Advanced disclosure
- no proof diagnostics, workflow source counts, or execution controls

Chat task receipts may focus this tab. A single-task receipt also selects the
created task; a batch receipt opens the list without choosing one task. The
panel refreshes from server-owned state and does not become task authority.

Agent Chat exposes one server-owned `task_ledger` portal with inspect, create,
and update actions. Inspection reads the same task DTO; updates remain
revision-checked commands. Inspection adds no visible card. Successful writes
use the existing compact receipt treatment and refresh the Tasks panel.
Lifecycle transitions and dispatch stay outside this portal.

The current Tasks-panel selection may also focus Agent Chat. The chat composer
shows one compact removable task label, sends only its task id, and leaves the
normal no-task chat path unchanged. The server resolves the current task DTO
for every enriched turn and supplies it as provider-only context. This focus is
local workspace state: it does not create durable task linkage, imply a task
mutation, or expose the larger selected-task workflow aggregate inside chat.

## Initial Task Workflow Portal

The second Agent Chat portal is `task_workflow`, initially with `inspect` and
`run` actions. `run` consumes one explicit conversation mandate and may cover a
single task or one goal's snapshotted ordered tasks. The user does not confirm
every task in that admitted goal scope.

The normal chat path gains no persistent autonomy toggle or workflow control
stack. A successful run shows one compact started receipt; a runway receipt
shows scope and current position. Confirmation-required, blocked, stopped, and
recovery states use the same compact treatment and may focus the Tasks panel.
Adapter ids, provider refs, work-item ids, revisions, mandate provenance, and
advanced recovery controls remain in task detail or disclosures.

The portal is not exposed until `run` reaches provider dispatch. Intermediate
delegation or scheduling proof records must not be presented as started work.

## Goals In The Task Surface

Goals are the normal grouping and continuity layer above tasks. The Tasks panel
should present goal groups with their ordered tasks instead of one unlimited
flat project list. Ungrouped tasks remain available in a final compact group.

The normal view shows goal title, status, progress summary, and contained task
rows. Goal outcome, scope, stop conditions, evidence, revision, and membership
editing remain behind detail or disclosures. Selecting a goal may focus Agent
Chat with one compact removable goal context label, parallel to selected-task
context.

Agents manage goals and task membership through `task_ledger`; Goals do not add
a fifth top-level agent tool. A compact goal-creation receipt may focus the
goal group. Granting `task_workflow run` authority to a goal remains a separate
conversation mandate and is never implied by creating or selecting it.

## Initial Code Editor Surface

The existing Editor panel becomes the first real file workspace after Agent
Chat and Tasks. It uses CodeMirror 6 as a client editing substrate and remains
visually subordinate to the current panel shell.

The normal editor view contains:

- one active host-authorized file buffer
- a compact project-relative path and dirty indicator
- the editor itself
- Save and a small overflow menu
- quick open through a popover or command, not a permanent explorer sidebar

The first slice supports open, edit, undo/redo, search, syntax presentation,
keyboard save, revision-checked save, reload, and explicit conflict state. It
does not add editor-internal file tabs, a minimap, breadcrumbs stack, persistent
outline, language-server features, formatter controls, VS Code extensions,
plugin UI, or automatic save.

CodeMirror state is disposable client interaction state. The Rust host returns
the current file snapshot and opaque revision, validates project scope and
write policy, rejects stale saves, and returns the new accepted snapshot. The
client must never silently overwrite an externally changed file.

Later diagnostics, completion, hover, formatting, rename, and code actions map
from server-owned language-server sessions into CodeMirror extensions. They do
not move language-server process authority into Svelte.
