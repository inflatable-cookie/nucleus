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
- UI decisions serve project workflows, not agent novelty

Drifting:

- Tauri becomes the state authority
- provider integrations rely on brittle UI scraping without an adapter contract
- projects collapse back to directory bookmarks
- tasks become a generic todo list with no agent execution shape
- implementation outruns the docs spine

## Next Task

Draft projection storage Rust surface boundaries.
