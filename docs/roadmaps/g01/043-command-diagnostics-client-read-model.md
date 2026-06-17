# 043 Command Diagnostics Client Read Model

Status: active
Owner: Tom
Updated: 2026-06-17

## Goal

Define and wire the read-only command diagnostics shape that clients can render
without decoding storage records.

## Scope

- Define the command diagnostics client read model.
- Add a client helper around the command history DTO if needed.
- Keep the desktop surface disposable and read-only.
- Prove clients do not need storage payloads for command history.
- Reassess whether a desktop diagnostics panel should be implemented next.

## Out Of Scope

- Raw artifact payload retrieval.
- Streaming command output.
- PTY command sessions.
- Write-enabled command controls.
- UI design finalization.

## Decisions

- Command history is now a server DTO surface.
- Desktop diagnostics should consume DTOs only.
- The first UI can be a proof interface, but it must still respect the server
  boundary.

## Execution Plan

- [ ] Define command diagnostics client read model.
- [ ] Add a typed client-side query helper where the current desktop/IPC shape
  needs one.
- [ ] Draft a read-only desktop diagnostics panel boundary.
- [ ] Add tests or fixtures proving the diagnostics path avoids storage
  payloads.
- [ ] Reassess whether to implement the disposable desktop panel next.

## Acceptance Criteria

- The client read model is explicit.
- The desktop path does not require storage decoding.
- Raw output remains absent.
- The next implementation lane is clear.

## Cards

- `docs/roadmaps/g01/batch-cards/246-define-command-diagnostics-client-read-model.md`
- `docs/roadmaps/g01/batch-cards/247-add-command-history-client-query-helper.md`
- `docs/roadmaps/g01/batch-cards/248-draft-read-only-command-diagnostics-panel-boundary.md`
- `docs/roadmaps/g01/batch-cards/249-test-command-diagnostics-storage-decoupling.md`
- `docs/roadmaps/g01/batch-cards/250-reassess-disposable-desktop-command-panel.md`
