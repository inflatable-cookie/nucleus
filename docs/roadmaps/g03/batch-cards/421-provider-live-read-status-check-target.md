# 421 Provider Live Read Status Check Target

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../106-provider-live-read-status-check-smoke.md`

## Purpose

Find a bounded public pull request target for the approved status/check smoke.

## Governing Refs

- `../106-provider-live-read-status-check-smoke.md`
- `../104-provider-live-read-second-family-stopped-request.md`

## Acceptance Criteria

- [x] Target discovery uses read-only GitHub CLI commands.
- [x] Discovery fields avoid body, comments, review text, patches, and raw
  provider payloads.
- [x] Selected target is recorded only as repository plus pull request number
  or URL.

## Result

Selected target: `cli/cli#13705`.

## Stop Conditions

- Target discovery needs broad provider data.
- `gh` is unavailable or unauthenticated in a way that blocks public reads.
