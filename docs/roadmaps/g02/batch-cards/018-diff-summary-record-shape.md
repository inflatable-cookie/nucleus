# 018 Diff Summary Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../006-checkpoint-and-diff-foundation.md`

## Purpose

Add a provider-neutral diff summary shape that can describe source,
management, task, memory, planning, research, and artifact diffs.

## Scope

- Add diff summary ids, kinds, boundary refs, source refs, confidence, and
  summary fields in `nucleus-engine`.
- Add JSON encode/decode helpers for persisted diff summary records.
- Link diff summaries to checkpoint refs where available.

## Acceptance Criteria

- Diff summaries do not require Git hashes, branches, commits, or pull
  requests.
- Diff summaries can represent adapter-generated or Nucleus-generated views.
- Codec tests prove the shape round-trips as typed data.

## Validation

- `cargo test -p nucleus-engine diff_summary`
- `cargo check --workspace`

## Stop Conditions

- Stop if the summary shape tries to become a full patch format.
- Stop if Git terminology becomes mandatory in engine types.

## Outcome

Added provider-neutral diff summary records and codecs. The shape supports
summary metadata and changed paths, but not raw patch transport.
