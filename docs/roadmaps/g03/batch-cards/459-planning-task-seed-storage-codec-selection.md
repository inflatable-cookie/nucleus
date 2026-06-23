# 459 Planning Task Seed Storage Codec Selection

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Select the narrow durable storage shape for planning artifacts and task seed
candidates.

## Work

- [x] Audit existing local-store record codec patterns.
- [x] Choose whether planning records live in engine codecs, server codecs, or
  a future planning crate.
- [x] Document the selected first slice and deferred merge policy.

## Acceptance Criteria

- [x] Selection follows existing storage patterns.
- [x] No task promotion or task creation path is added.
- [x] Next implementation card has a bounded codec target.

## Result

- Selected model-owned JSON storage codec in `nucleus-engine`.
- Kept `nucleus-server` as composition/persistence owner, not planning schema
  owner.
- Deferred a future `nucleus-planning` crate until planning sessions,
  artifacts, projection policy, and merge policy need their own crate.
- Documented the decision in
  `docs/architecture/planning-task-seed-storage-codec-selection.md`.
