# 247 Add Command History Client Query Helper

Status: planned
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed helper for clients to request command history without touching
storage records.

## Scope

- Reuse the existing control query vocabulary.
- Return typed command evidence DTO records.
- Keep error handling explicit.

## Out Of Scope

- Network transport.
- Artifact downloads.
- UI implementation.

## Promotion Targets

- `crates/nucleus-server`
- `apps/desktop`

## Acceptance Criteria

- Desktop or IPC code can request command history through a helper.
- No client code decodes `CommandEvidence` storage payloads.
