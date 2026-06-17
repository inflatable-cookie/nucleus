# 224 Publish Sanitized Spawn Evidence

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Publish sanitized supervision events and command evidence for the first spawn
path.

## Scope

- Emit accepted, running, terminal, and cleanup-failed shapes where applicable.
- Store sanitized command evidence.
- Keep raw stdout and stderr out of default state.
- Use artifact refs only where policy allows.

## Out Of Scope

- Full artifact payload storage.
- UI event streaming.
- Remote replay.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Evidence is sanitized.
- Raw output is not persisted by default.
- Event order is deterministic in tests.
