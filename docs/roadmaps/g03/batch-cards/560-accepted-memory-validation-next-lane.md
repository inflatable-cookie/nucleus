# 560 Accepted Memory Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../127-accepted-memory-authority-proof.md`

## Purpose

Validate accepted-memory authority proof and choose the next lane.

## Work

- [x] Run focused memory/server tests.
- [x] Run docs QA, Northstar QA, diff check, doctor, and relevant cargo check.
- [x] Decide whether read-only accepted-memory inspection, memory projection
  policy, memory search, or product review controls should be next.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane is selected from evidence.
- [x] The project avoids adding embeddings/search/projection/UI before accepted
  memory persistence proves useful.

## Result

Validation passed for the accepted-memory authority proof:

- `cargo test -p nucleus-memory -- --nocapture`
- `cargo test -p nucleus-server accepted_memory_persistence -- --nocapture`
- `cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

`effigy doctor` remains warning-only for god-file findings.

Next lane selected: read-only accepted-memory inspection. This is the smallest
useful follow-on because it lets the server prove accepted memory can be read
and summarized without opening projection, embeddings, semantic search,
provider-native sync, automatic extraction, final UI, SCM/forge mutation, or
task mutation.
