# 019 Checkpoint Diff Query Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../006-checkpoint-and-diff-foundation.md`

## Purpose

Expose checkpoint and diff records through the server control boundary as
read-only diagnostics.

## Scope

- Add server state helpers to write and list checkpoint/diff records.
- Add control API query/result variants for listing checkpoint and diff
  records.
- Add response DTOs that expose sanitized records without raw patches or
  provider streams.

## Acceptance Criteria

- Checkpoint and diff list queries return typed records.
- The first storage location does not corrupt runtime receipt reads.
- DTOs keep SCM adapter refs optional and neutral.

## Validation

- focused `nucleus-server` checkpoint/diff query tests
- `cargo check --workspace`

## Stop Conditions

- Stop if query support requires a remote transport decision.
- Stop if the server starts mutating worktrees or SCM state.

## Outcome

Added server state helpers, control API query results, and response DTOs for
read-only checkpoint and diff summary listings.
