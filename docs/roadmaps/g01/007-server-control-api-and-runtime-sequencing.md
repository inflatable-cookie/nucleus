# 007 Server Control API And Runtime Sequencing

Status: complete
Owner: Tom
Updated: 2026-06-16

## Goal

Turn the local state substrate into the first server-owned control boundary,
then sequence auth, event replay, runtime scheduling, and Tauri readiness
without letting the desktop app become the state authority.

## Scope

- Add a local server state service facade over `nucleus-local-store`.
- Define first command/query value surfaces for project, task, workspace,
  adapter/session, route, and runtime metadata state.
- Keep the first API local and in-process until the server contract is stable
  enough for HTTP/WebSocket/local socket transport selection.
- Add local-only client identity and auth readiness gates without remote
  pairing behavior.
- Add event replay/query skeletons before live subscriptions.
- Add runtime scheduler acceptance-queue types after command authority is
  visible.
- Reassess Tauri shell readiness once a client can consume server-owned
  project/task/workspace state.

## Out Of Scope

- Tauri UI implementation.
- Network server implementation.
- Remote auth, LAN pairing, internet pairing, or user account service.
- Live harness adapters.
- Command execution.
- Scheduler process execution.
- Live event subscriptions.
- Secret backend implementation.
- Postgres or remote database backend implementation.
- Provider-specific runtime behavior.

## Decisions

- Next implementation lane: server control API and service boundary, not
  Tauri UI and not provider runtime.
- First API shape: local Rust command/query/service types. Network transport
  follows after the authority model is testable.
- Auth starts as local readiness and deployment-profile vocabulary. Remote
  pairing remains deferred.
- Runtime scheduler starts only after command authority, event persistence,
  and replay query boundaries exist.
- Tauri remains a client. It can begin once local server state can be queried
  and mutated through server-owned boundaries.

## Execution Plan

- [x] Add local server state service facade over `nucleus-local-store`.
- [x] Add control API command, query, response, and error value types.
- [x] Add local client identity and auth readiness gates.
- [x] Add event replay/query service skeletons for stored event metadata.
- [x] Add runtime scheduler acceptance-queue types.
- [x] Reassess Tauri shell readiness against the local control boundary.

## Acceptance Criteria

- [x] Server state access is mediated through a service boundary instead of
  direct client use of storage repositories.
- [x] First command/query types preserve server authority over projects,
  tasks, workspaces, adapter registry records, sessions, routes, and runtime
  metadata.
- [x] Local auth readiness is explicit without pretending remote pairing
  exists.
- [x] Event replay/query behavior can be tested without live subscriptions.
- [x] Scheduler acceptance queues do not execute commands or spawn provider
  processes.
- [x] Tauri readiness is assessed from a server-client boundary, not from UI
  preference.

## Readiness Reassessment

The desktop shell should not start yet.

Ready enough:

- local server-owned state facade exists
- transport-neutral command/query vocabulary exists
- explicit local auth readiness gates exist
- read-only event replay/query skeleton exists
- inert scheduler admission queue exists

Still blocking:

- no local control request handler
- no selected local client transport boundary
- no state query execution through the control API
- no command mutation handling through the control API
- no client-facing bootstrap profile for the desktop app

The next lane should build a local request-handling boundary before Tauri
scaffolding.

## Cards

- `docs/roadmaps/g01/batch-cards/080-draft-server-control-api-and-runtime-sequencing.md`
- `docs/roadmaps/g01/batch-cards/081-add-local-server-state-service-facade.md`
- `docs/roadmaps/g01/batch-cards/082-add-control-api-command-query-types.md`
- `docs/roadmaps/g01/batch-cards/083-add-local-client-auth-readiness-gates.md`
- `docs/roadmaps/g01/batch-cards/084-add-event-replay-query-service-skeleton.md`
- `docs/roadmaps/g01/batch-cards/085-add-runtime-scheduler-acceptance-queue.md`
- `docs/roadmaps/g01/batch-cards/086-reassess-tauri-shell-readiness.md`

## Deferred Lanes

- Local control request handling and transport readiness. This is now the next
  lane in `008-local-request-handling-and-transport-readiness.md`.
- Tauri desktop shell and panel implementation.
- HTTP/WebSocket/local socket implementation.
- Remote auth, remote pairing, and multi-user account service.
- Command runner and sandbox runtime.
- Provider adapter process lifecycle.
- SCM worktree/branch execution.
- Postgres or remote database backend.
