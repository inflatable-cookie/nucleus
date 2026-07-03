# 510 Planning Session Storage Codec

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Add a first storage codec for planning session and exploration records if the
record boundary is stable.

## Work

- [x] Select JSON or TOML storage payload shape for local-store records.
- [x] Add encode/decode tests for session and exploration records.
- [x] Keep projection/export/import behavior deferred.

## Acceptance Criteria

- [x] Codec round trips stable ids, status, refs, and structured planning
  fields.
- [x] Codec does not store raw transcripts, secrets, provider payloads, or
  private memories.
- [x] No active planning mutation command is introduced.

## Evidence

- Selected JSON storage payloads to match existing project/task storage codec
  posture.
- Added `PlanningSessionStorageRecord` and
  `ExplorationSessionStorageRecord`.
- Added storage enums and nested records for participants, source refs,
  outputs, questions, assumptions, options, tradeoffs, notes, and promotion
  refs.
- Added encode/decode helpers for planning and exploration session payloads.
- Exported the codec surface from `nucleus-planning` without adding server,
  task, provider, memory, research, projection/import, or UI behavior.
- `cargo test -p nucleus-planning` passed.
- `cargo check --workspace` passed.
