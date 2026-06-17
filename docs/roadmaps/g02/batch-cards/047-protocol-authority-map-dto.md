# 047 Protocol Authority Map DTO

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../013-host-authority-map-and-client-protocol-records.md`

## Purpose

Add transport-safe DTOs for authority-map read models after the server records
and query shape exist.

## Scope

- Add serializable DTOs for host identity, host form, authority domains,
  assignments, fallbacks, mutation allowance, and publication state.
- Keep DTOs as protocol boundary records only.
- Add round-trip tests for supported shapes.
- Reject unsupported authority-map payloads explicitly.

## Acceptance Criteria

- DTOs can serialize client-visible authority-map read models.
- DTOs do not become durable state authority.
- Unsupported shapes fail as codec errors, not silent empty maps.

## Validation

- `cargo test -p nucleus-server authority_map`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if the DTO requires changing durable authority-map semantics.

## Outcome

Completed 2026-06-17.

Added transport-safe response DTOs for project authority-map publications,
domain publication rows, and validation issues. Authority-map DTO responses now
serialize through the control response envelope without becoming durable
authority.
