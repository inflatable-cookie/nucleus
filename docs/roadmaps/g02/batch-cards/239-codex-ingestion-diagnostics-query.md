# 239 Codex Ingestion Diagnostics Query

Status: planned
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

## Validation

- targeted server serialization/query tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics require UI design decisions.
