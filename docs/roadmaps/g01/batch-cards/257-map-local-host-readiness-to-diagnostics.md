# 257 Map Local Host Readiness To Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Map existing local host readiness descriptors into the diagnostics read model.

## Scope

- Review local sandbox, artifact store, event transport, and process control
  readiness descriptors.
- Identify reusable fields.
- Identify missing fields.

## Out Of Scope

- New backend implementation.
- Changing readiness semantics.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Mapping is explicit.
- Missing fields are documented.

## Outcome

Mapped local host runtime discovery findings and backend evidence refs into
sanitized readiness diagnostics.
