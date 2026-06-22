# 267 Provider Read-Intent Control Handler Route

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../071-provider-read-intent-control-boundary.md`

## Purpose

Route provider read-intent projection queries through the local control request
handler.

## Acceptance Criteria

- [x] Handler dispatch accepts provider read-intent projection queries.
- [x] Handler delegates to the local-store backed query composition.
- [x] Storage failures map through the existing server control error path.
- [x] Query execution remains read-only and stopped by default.

## Notes

The handler route exposes already-persisted local evidence only. It does not
resolve credentials or call provider networks.
