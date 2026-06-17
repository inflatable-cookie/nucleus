# 017 Checkpoint Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../006-checkpoint-and-diff-foundation.md`

## Purpose

Add the first engine-owned checkpoint record shape without treating checkpoints
as Git commits.

## Scope

- Add checkpoint ids, families, refs, recovery states, and records in
  `nucleus-engine`.
- Add JSON encode/decode helpers for persisted checkpoint records.
- Keep SCM mutation, snapshot capture, worktree creation, and provider
  checkpoint adapters out of scope.

## Acceptance Criteria

- Checkpoint records can identify project, authority host, actor, workflow,
  causal command/event refs, parent checkpoints, artifacts, and summary.
- The type vocabulary uses checkpoint/snapshot/publication language, not
  Git-only commit language.
- Codec tests prove the shape round-trips as typed data.

## Validation

- `cargo test -p nucleus-engine checkpoint`
- `cargo check --workspace`

## Stop Conditions

- Stop if checkpoint identity needs a new global storage domain decision.
- Stop if implementation starts creating SCM branches, commits, or worktrees.

## Outcome

Added engine-owned checkpoint ids, families, refs, recovery states, records,
and JSON codecs without requiring Git commit semantics.
