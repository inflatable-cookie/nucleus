# 239 Codex Ingestion Diagnostics Query

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Expose read-only diagnostics for Codex event acceptance.

## Scope

- Query accepted, duplicated, unsupported, recovery-required, and receipt-linked
  observations.
- Keep DTOs compact and split by domain if they grow.
- Do not add desktop panels.

## Acceptance Criteria

- Clients can inspect event acceptance state without becoming authoritative.
- Diagnostics show next required action for blocked or recovery-required
  observations.
- Serialization tests cover the new query shapes.

## Result

`nucleus-server` now exposes read-only Codex ingestion diagnostics DTOs under
`diagnostics_read_models/codex_ingestion.rs`.

The diagnostics show observation status, next action, event refs, receipt refs,
evidence refs, and explicit no-mutation/no-provider-execution authority flags.
No desktop panel was added.

## Validation

- targeted server serialization/query tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics require UI design decisions.
