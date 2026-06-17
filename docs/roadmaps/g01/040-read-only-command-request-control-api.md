# 040 Read-Only Command Request Control API

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define and implement the first narrow control API path for read-only command
requests without opening a general shell or arbitrary execution surface.

## Scope

- Define control request and response shape for local read-only command
  execution.
- Keep invocation structured as executable plus argv.
- Preserve host-spawn readiness, policy rejection, and sanitized evidence
  behavior.
- Add tests for accepted, rejected, and persisted read-only command outcomes.
- Decide whether the CLI should accept a constrained invocation next.

## Out Of Scope

- Desktop command controls.
- Write-enabled commands.
- PTY or terminal streaming.
- Network-capable commands.
- Remote execution.
- General shell passthrough.

## Decisions

- The fixed smoke path proves execution mechanics, not user input policy.
- Client-facing command requests need DTO and admission rules before the CLI or
  desktop accepts arbitrary executable values.
- Raw output remains unavailable by default.

## Execution Plan

- [x] Compile read-only command control API shape.
- [x] Add server request DTO and response DTO for read-only commands.
- [x] Route accepted read-only commands to the server spawn helper.
- [x] Add rejection and persistence tests.
- [x] Reassess constrained CLI input readiness.

## Acceptance Criteria

- Control API shape is explicit before client input is accepted.
- Shell passthrough remains blocked.
- Host readiness still gates execution.
- Persisted evidence remains sanitized.
- The next CLI/desktop expansion is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/231-compile-read-only-command-control-api-shape.md`
- `docs/roadmaps/g01/batch-cards/232-add-read-only-command-control-dtos.md`
- `docs/roadmaps/g01/batch-cards/233-route-read-only-command-requests-to-spawn-helper.md`
- `docs/roadmaps/g01/batch-cards/234-add-read-only-command-rejection-and-persistence-tests.md`
- `docs/roadmaps/g01/batch-cards/235-reassess-constrained-cli-input-readiness.md`

## Closeout

Implemented a narrow structured read-only command control API.

- Added `ReadOnlyCommand` under `ServerCommandKind`.
- Added `run_read_only_command_control` and sanitized
  `ReadOnlyCommandControlResult`.
- Added request DTO support through `ControlCommandDto::ReadOnlyCommand`.
- Added response DTO support through
  `ControlResponseBodyDto::ReadOnlyCommandResult`.
- Routed local handler read-only commands through the server spawn helper.
- Added tests for DTO round-trip, accepted execution, shell passthrough
  rejection, invalid working directory rejection, missing timeout/unbounded
  output rejection, and sanitized evidence persistence.

Constrained CLI input is ready as the next lane. Desktop controls should wait
until the CLI proves the operator-facing shape.
