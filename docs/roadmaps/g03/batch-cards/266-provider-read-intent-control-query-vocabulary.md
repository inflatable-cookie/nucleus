# 266 Provider Read-Intent Control Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../071-provider-read-intent-control-boundary.md`

## Purpose

Add the server control API vocabulary needed for provider read-intent projection
queries.

## Acceptance Criteria

- [x] `ServerQueryKind` includes a provider read-intent query family.
- [x] Provider read-intent query family starts with projection only.
- [x] `ServerQueryResult` can carry the existing read-intent query result.
- [x] No provider write, credential resolution, or network authority is added.

## Notes

This is a transport-neutral in-process control shape. Wire DTO support is not
implied.
