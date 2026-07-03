# 522 Research Run Brief Record Types

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Model research runs as brief-first investigation records.

## Work

- [x] Add stable research run ids.
- [x] Add run status, optional project ref, title, brief, scope boundary,
  source plan refs, confidence, coverage, and timestamps.
- [x] Add tests that run briefs are not active execution.

## Acceptance Criteria

- [x] Project-bound and standalone research runs are represented.
- [x] Research run status does not grant execution or promotion authority.
- [x] Raw source payloads, browser caches, provider payloads, private notes,
  credentials, and secret-bearing files are not represented as body fields.

## Evidence

- `cargo test -p nucleus-research`
- `cargo check --workspace`
