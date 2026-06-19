# 193 GitHub Review Boundary Descriptor

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../042-change-request-preparation-boundary.md`

## Purpose

Add GitHub descriptor mapping for change-request candidates without network
execution.

## Scope

- Represent GitHub-specific labels, required refs, and review-boundary fields.
- Keep provider descriptors separate from neutral candidate records.
- Do not call GitHub APIs.

## Acceptance Criteria

- GitHub descriptor mapping is testable without network access.
- Core records do not require GitHub-only concepts.

## Validation

- Targeted Rust tests for GitHub descriptor mapping.
- `cargo check --workspace`

## Stop Conditions

- Stop if GitHub fields leak into neutral candidate records.
