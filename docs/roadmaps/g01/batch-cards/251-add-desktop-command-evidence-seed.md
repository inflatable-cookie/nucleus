# 251 Add Desktop Command Evidence Seed

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Give the disposable desktop command diagnostics panel realistic local command
evidence to render.

## Scope

- Seed sanitized command evidence through Rust server state during desktop
  bootstrap, or use an existing server-owned command path if safer.
- Keep the seed deterministic.
- Avoid raw output and artifact payloads.

## Out Of Scope

- Executing a command at desktop startup.
- Artifact payload storage.
- User-controlled command input.

## Promotion Targets

- `apps/desktop/src-tauri`
- `apps/desktop/README.md`

## Acceptance Criteria

- Desktop command diagnostics can display at least one record locally.
- Seeded evidence uses server state helpers.
- Raw output stays absent.

## Outcome

Desktop bootstrap now writes one deterministic sanitized command evidence
record through `write_command_evidence` using `RevisionExpectation::Any`.
Startup does not execute a command or retain raw output.
