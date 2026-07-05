# 575 Accepted Memory Import Candidates And Admission

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../131-accepted-memory-projection-import-validation.md`

## Purpose

Scan projected accepted-memory TOML files and classify stopped import
candidates before active memory apply exists.

## Work

- [x] Add projected memory import candidate records from file refs and decoded
  payloads.
- [x] Validate schema, memory id, path safety, project scope, sensitivity,
  retention, review evidence, and unsupported future schema.
- [x] Add stopped import admission records for valid reviewed candidates.
- [x] Block invalid, unsupported, unsafe, private, restricted, unreviewed, and
  duplicate candidate states without mutating active accepted memory.
- [x] Preserve no-effect flags for active apply, SCM/forge, embeddings/search,
  provider sync, task mutation, and UI behavior.

## Acceptance Criteria

- [x] Tests cover ready candidates and blocked candidate classes.
- [x] Tests prove admission does not create or mutate accepted-memory records.
- [x] Tests prove raw transcripts, provider payloads, terminal streams,
  private notes, credentials, and secret values are not retained.
- [x] The implementation stays in focused modules rather than broad `lib.rs`
  changes.
