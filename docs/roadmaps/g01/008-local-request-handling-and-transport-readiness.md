# 008 Local Request Handling And Transport Readiness

Status: complete
Owner: Tom
Updated: 2026-06-16

## Goal

Turn the local server control vocabulary into a testable request-handling
boundary, then choose the first local client transport posture before Tauri is
scaffolded.

## Scope

- Add a local control request handler skeleton.
- Route read-only state queries through server-owned services.
- Route command receipts and admissibility checks without executing commands.
- Keep mutation behavior narrow and explicit.
- Define local transport readiness types for desktop bootstrap.
- Reassess whether Tauri can start as a thin client shell.

## Out Of Scope

- Tauri app scaffolding.
- HTTP, WebSocket, local socket, or Tauri IPC implementation.
- Remote auth and pairing.
- Command execution.
- Provider process lifecycle.
- Live subscriptions.
- Worktree or SCM mutation.
- Background workers.

## Decisions

- The next lane is local request handling, not desktop UI.
- Request handling should stay transport-neutral until state query and command
  receipt behavior is testable.
- Local transport selection should be a readiness boundary first, not a
  network implementation.
- Desktop bootstrap remains blocked until the server can handle local control
  requests through a selected transport posture.

## Execution Plan

- [x] Add local control request handler skeleton.
- [x] Execute read-only state queries through the handler.
- [x] Add command receipt/admissibility handling without runtime execution.
- [x] Add local transport readiness and bootstrap profile types.
- [x] Reassess desktop shell bootstrap readiness.

## Acceptance Criteria

- [x] A local handler can accept `ServerControlRequest` values without binding
  to HTTP, WebSocket, Tauri IPC, or local sockets.
- [x] Read-only state queries go through `ServerStateService`.
- [x] Command requests return receipts or explicit errors without executing
  runtime effects.
- [x] Runtime scheduler admission can be referenced without starting workers.
- [x] Local transport readiness is explicit enough to guide desktop bootstrap.
- [x] No Tauri UI, network server, provider process, command runner, or live
  subscription behavior is introduced.

## Desktop Bootstrap Reassessment

Do not scaffold the Tauri desktop shell yet.

Ready enough:

- local request handler accepts transport-neutral control requests
- read-only state queries execute through server-owned services
- command requests return deterministic receipts or explicit rejections
- local transport candidates and desktop bootstrap requirements are named

Still blocking:

- no local control transport trait boundary
- no in-process client fixture for request/response behavior
- no Tauri IPC command schema readiness
- no desktop bootstrap profile wired to a concrete local transport

The next lane should build local transport and desktop bootstrap preparation
without creating the Tauri UI yet.

## Cards

- `docs/roadmaps/g01/batch-cards/087-compile-local-request-handler-runway.md`
- `docs/roadmaps/g01/batch-cards/088-add-local-control-request-handler-skeleton.md`
- `docs/roadmaps/g01/batch-cards/089-add-state-query-handler-execution.md`
- `docs/roadmaps/g01/batch-cards/090-add-command-receipt-admissibility-handling.md`
- `docs/roadmaps/g01/batch-cards/091-add-local-transport-readiness-types.md`
- `docs/roadmaps/g01/batch-cards/092-reassess-desktop-bootstrap-readiness.md`

## Deferred Lanes

- Local transport implementation. This is now the next lane in
  `009-local-transport-and-desktop-bootstrap-prep.md`.
- Tauri desktop shell.
- Network transport implementation beyond local bootstrap prep.
- Remote auth and pairing.
- Live event subscriptions.
- Runtime workers and process execution.
- Provider adapters.
