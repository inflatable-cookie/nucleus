# 020 Checkpoint Diff Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../006-checkpoint-and-diff-foundation.md`

## Purpose

Prove the first checkpoint/diff foundation is SCM-neutral, queryable, and
documented before moving to projection sync work.

## Scope

- Add focused tests for checkpoint and diff storage/query/DTO behavior.
- Update the checkpoint diff contract with the first implementation boundary.
- Close the milestone and cards when validation passes.

## Acceptance Criteria

- Engine tests cover checkpoint and diff codecs.
- Server tests cover typed listing without runtime receipt collision.
- Docs state what is implemented and what remains out of scope.

## Validation

- `cargo test -p nucleus-engine checkpoint`
- `cargo test -p nucleus-engine diff_summary`
- focused `cargo test -p nucleus-server checkpoint_diff`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if validation reveals a storage-domain collision.
- Stop if docs need new operator decisions about SCM authority.

## Outcome

Focused engine and server tests pass. Checkpoint/diff records are stored
separately from runtime receipts, and runtime receipt list queries remain
empty when only checkpoint/diff metadata exists.
