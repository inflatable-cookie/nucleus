# 249 Test Command Diagnostics Storage Decoupling

Status: planned
Owner: Tom
Updated: 2026-06-17

## Goal

Prove the command diagnostics path uses typed DTOs instead of storage payloads.

## Scope

- Add a focused test or fixture around the client query helper.
- Assert command history records render from DTO fields.
- Assert raw output and storage payload bytes stay absent.

## Out Of Scope

- Browser screenshots.
- End-to-end UI testing.
- Artifact payload tests.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop`

## Acceptance Criteria

- Tests fail if the diagnostics path depends on raw storage records.
- Tests fail if raw output fields appear.
