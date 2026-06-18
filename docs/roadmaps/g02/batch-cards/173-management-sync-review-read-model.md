# 173 Management Sync Review Read Model

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Expose management sync review state without giving clients mutation authority.

## Scope

- Add read-model or DTO shape for staged records, apply plans, conflicts,
  receipts, and repair proposals.
- Keep review data provider-neutral and safe for desktop, web, CLI, or steward
  consumers.
- Avoid proof UI expansion unless a minimal query fixture requires it.

## Acceptance Criteria

- A client can show what will apply, what is blocked, and why.
- The read model does not expose raw secrets, raw runtime streams, or provider
  auth material.
- Mutation remains behind admitted commands.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the read model requires UI design choices or SCM publication policy.

## Result

- Added `SyncReviewModelDto` for staged, invalid, unsupported, applied,
  blocked, conflict, repair, and receipt review state.
- Kept the read model client-safe: no raw projection payloads, raw runtime
  streams, provider auth, or SCM mutation authority.
- Split review DTOs into `diagnostics_read_models/sync_review.rs` so the sync
  diagnostics module stays focused.
- Did not add UI controls, SCM capture/publish behavior, or mutation routes.
