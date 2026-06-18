# 173 Management Sync Review Read Model

Status: planned
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
