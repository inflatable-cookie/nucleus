# 192 Change Request Candidate Records

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../042-change-request-preparation-boundary.md`

## Purpose

Add provider-neutral change-request candidate records.

## Scope

- Add records for title, summary, evidence refs, target review boundary, and
  policy gates.
- Link candidates to capture and work-session evidence where available.
- Do not open or update provider review requests.

## Acceptance Criteria

- Change-request candidates are durable and provider-neutral.
- Admission blocks missing evidence.

## Validation

- Targeted Rust tests for candidate records.
- `cargo check --workspace`

## Stop Conditions

- Stop if candidates become GitHub pull-request records by default.
