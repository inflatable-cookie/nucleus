# 001 Nucleus Product Vision

Status: draft
Owner: Tom
Purpose: define the long-horizon target for a project-first AI development
environment.

## Long-Term Outcome

Nucleus becomes a durable project management environment for AI-assisted
software work.

It should let a developer manage many projects, repos, agents, tasks,
terminals, browsers, and workspaces from one coherent system without forcing
all work through one provider or one local desktop session.

The core product idea is server-first continuity:

- project state survives client restarts
- agent sessions are managed by the server
- desktop, web, mobile, and CLI clients are control planes
- remote deployment is a first-class option
- switching clients does not lose state

## Strategic Constraints

- Rust is the core implementation language.
- Tauri desktop is the first client, not the authority surface.
- The server owns durable state and harness process lifecycle.
- Native harness behavior is respected instead of flattened into a false
  lowest-common-denominator experience.
- Projects are durable entities, not aliases for filesystem paths.
- A project may contain multiple repos.
- Tasks are first-class work units and should be agent-ready when possible.
- Specification should lead implementation until the core contracts settle.

## Target Envelopes

- Adapter protocol: stable enough to support SDK, ACP, and CLI/PTY harnesses.
- Project model: survives repo moves through explicit path history and repair.
- Task model: supports importance, staleness, actions, and delegation.
- Shared memory: preserves accepted project context across harnesses without
  relying on provider-native memory.
- Structured planning: guides project intake, vision, architecture,
  brainstorming, roadmaps, and task seeds as server-owned records.
- Deep research: builds evidence-backed understanding for planning, tasks, or
  standalone investigations.
- Effigy integration: makes project task routing, health, and validation
  seamless when a project opts in.
- Server: deployable locally, on LAN, or over the internet.
- Clients: thin control planes over the same server authority.
- Workspace: persistent per-project layouts for panels, tabs, terminals, and
  browser views.

## Alignment Signals

Aligned:

- docs promote research into architecture and contracts before roadmap work
- crates stay small and independently testable
- provider adapters expose capability differences plainly
- project and task state remain durable across clients
- accepted memories and planning artifacts become project context rather than
  disappearing inside one harness transcript
- research output preserves sources, observations, synthesis, confidence, and
  gaps instead of becoming disposable chat
- opted-in Effigy projects expose validation and workflow tasks to agents
  without manual command guessing
- UI decisions serve project workflows, not agent novelty

Drifting:

- Tauri becomes the state authority
- provider integrations rely on brittle UI scraping without an adapter contract
- projects collapse back to directory bookmarks
- tasks become a generic todo list with no agent execution shape
- memory becomes unreviewed transcript dumping or hidden provider state
- project planning becomes a loose chat flow with no durable artifact model
- deep research becomes unsourced model prose with no evidence trail
- agents bypass project task runners and invent one-off command rituals
- implementation outruns the docs spine
