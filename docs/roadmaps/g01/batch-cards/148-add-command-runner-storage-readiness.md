# 148 Add Command Runner Storage Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare command runner evidence and request records for safe persistence.

## Scope

- Add or refine storage-ready records for command requests and sanitized
  evidence.
- Preserve command id, status, summary, exit status, and artifact refs.
- Keep raw stdout/stderr out of normal state.

## Out Of Scope

- Process execution.
- Artifact payload backend.
- Secret storage.
- Provider processes.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-command-policy`
- `crates/nucleus-server`
- `crates/nucleus-local-store`

## Acceptance Criteria

- Command request/evidence records can be persisted as metadata.
- Raw output is not stored by default.
- Storage behavior can be tested without spawning a process.

## Closeout

- Added command request and sanitized evidence JSON storage records in
  `nucleus-command-policy`.
- Added encode/decode helpers and domain round-trip conversion helpers.
- Added tests proving request/evidence metadata round-trips without raw output
  fields.
