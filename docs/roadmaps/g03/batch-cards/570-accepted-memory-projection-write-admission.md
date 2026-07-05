# 570 Accepted Memory Projection Write Admission

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../130-accepted-memory-projection-file-materialization.md`

## Purpose

Add the admission boundary for accepted-memory projection file writes before
any writer is allowed to touch `nucleus/memory/`.

## Work

- [x] Define accepted-memory projection write intent/admission records.
- [x] Require policy-projectable status before a write can be admitted.
- [x] Require deterministic plan refs and safe `nucleus/memory/<memory-id>.toml`
  file refs.
- [x] Preserve blocked, local-only, and review-required outcomes as diagnostics
  instead of writes.
- [x] Expose no-effect flags proving no file, SCM, import/apply, embedding,
  provider-sync, task, or UI effect has run.

## Acceptance Criteria

- [x] Tests prove only projectable accepted memories produce admitted write
  intents.
- [x] Tests prove unsafe refs, blocked policy, unsupported schema, unsupported
  kind, and missing file refs do not admit writes.
- [x] The model does not write files or mutate SCM.
- [x] The implementation stays in focused modules rather than `lib.rs`.

## Result

Accepted-memory projection write admission is now a pure no-effect boundary.
It admits only stopped, projectable export entries with deterministic plan refs
and safe `nucleus/memory/<memory-id>.toml` file refs.

Blocked policy states, export blockers, unsafe refs, tampered refs, missing
file refs, and prior effects remain blocked diagnostics instead of write
authority.
