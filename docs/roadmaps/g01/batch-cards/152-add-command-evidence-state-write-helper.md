# 152 Add Command Evidence State Write Helper

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a small server helper for writing sanitized command evidence into the
command evidence state domain.

## Scope

- Convert `CommandEvidence` into a local-store record using the command evidence
  storage codec.
- Store the record in `ServerStateDomain::CommandEvidence`.
- Use revision checks consistently with other state writes.

## Out Of Scope

- Process execution.
- Artifact payload storage.
- Event publication.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Helper writes sanitized command evidence metadata.
- Helper can read the record back after write.
- Tests prove raw output fields are not introduced.

## Closeout

- Added `write_command_evidence` in `nucleus-server`.
- The helper writes JSON command evidence metadata to the command evidence
  state domain with explicit revision expectations.
- Tests prove readback and absence of raw output fields.
