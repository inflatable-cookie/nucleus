# 045 Runtime Readiness Diagnostics Query Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Expose read-only runtime readiness diagnostics so clients can explain what the
local host can and cannot do before richer command controls exist.

## Scope

- Define runtime readiness diagnostics fields for clients.
- Reuse existing host/runtime readiness vocabulary where possible.
- Add a typed query response shape if needed.
- Keep diagnostics read-only.
- Reassess whether the next UI panel should show readiness, artifact metadata,
  or command event timeline.

## Out Of Scope

- Enabling new command classes.
- Artifact payload retrieval.
- Streaming output.
- PTY sessions.
- Remote host transport.

## Decisions

- Command history answers what happened.
- Runtime readiness should answer what the host is ready to do and why it is
  blocked.
- Readiness diagnostics must not grant command authority.

## Execution Plan

- [x] Define runtime readiness diagnostics read model.
- [x] Map existing local host readiness descriptors to client fields.
- [x] Add typed query response DTO or helper if the current control surface is
  too generic.
- [x] Add CLI or desktop fixture coverage for readiness diagnostics.
- [x] Reassess the next diagnostics UI lane.

## Outcome

- Added server runtime readiness diagnostics projection types.
- Added `get_local_runtime_readiness` control query support.
- Added sanitized runtime readiness response DTOs.
- Added desktop control helper coverage for the typed query response.
- Next lane: add a disposable read-only runtime readiness panel.

## Acceptance Criteria

- Clients can render readiness without decoding internal structs.
- Blockers are explicit and sanitized.
- No command execution authority changes.
- The next implementation lane is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/256-define-runtime-readiness-diagnostics-read-model.md`
- `docs/roadmaps/g01/batch-cards/257-map-local-host-readiness-to-diagnostics.md`
- `docs/roadmaps/g01/batch-cards/258-add-runtime-readiness-query-dto.md`
- `docs/roadmaps/g01/batch-cards/259-test-runtime-readiness-diagnostics.md`
- `docs/roadmaps/g01/batch-cards/260-reassess-readiness-diagnostics-ui.md`
