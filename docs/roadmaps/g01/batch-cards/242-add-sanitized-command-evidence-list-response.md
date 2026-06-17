# 242 Add Sanitized Command Evidence List Response

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Return sanitized command evidence summaries from the control response DTO.

## Scope

- Decode command evidence records.
- Return typed sanitized DTOs.
- Keep fallback state-record response for unsupported records if needed.

## Out Of Scope

- Raw output.
- Artifact payload download.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Query response serializes command evidence summaries.
- Raw output fields are absent.

## Outcome

`CommandEvidence` storage records now project to typed control response DTOs
for `CommandEvidence` state sets.
