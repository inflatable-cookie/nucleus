# 244 Test Command History Raw Output Absence

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prove command history does not expose raw output.

## Scope

- Run a command with recognizable stdout.
- Query command history.
- Assert output text is absent from stored payload and printed response.

## Out Of Scope

- Artifact payload tests.
- Desktop UI tests.

## Promotion Targets

- `crates/nucleus-server`
- `apps/nucleusd`

## Acceptance Criteria

- Tests fail if raw stdout/stderr appears.

## Outcome

Server DTO tests and CLI formatting tests assert that raw output fields are not
present in command history surfaces.
