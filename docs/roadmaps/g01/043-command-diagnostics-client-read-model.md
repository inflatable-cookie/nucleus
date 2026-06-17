# 043 Command Diagnostics Client Read Model

Status: completed
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

- [x] Define command diagnostics client read model.
- [x] Add a typed client-side query helper where the current desktop/IPC shape
  needs one.
- [x] Draft a read-only desktop diagnostics panel boundary.
- [x] Add tests or fixtures proving the diagnostics path avoids storage
  payloads.
- [x] Reassess whether to implement the disposable desktop panel next.

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

## Outcome

Desktop command diagnostics now has a typed command-history helper, a
fixture-backed IPC test that proves storage payloads remain hidden, and a first
disposable Svelte panel that renders read-only command evidence DTOs.

The panel is useful enough for hardening, not final UI. The next lane should
seed realistic local evidence, verify the panel visually, and keep artifact or
execution controls out until their server contracts exist.
