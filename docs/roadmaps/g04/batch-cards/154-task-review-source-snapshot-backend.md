# 154 Task Review Source Snapshot Backend

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../029-task-attributed-diff-review.md`
Auto-start next card: yes

## Objective

Implement the immutable host-local snapshot backend that can preserve exact
task review boundaries without modifying the project or SCM.

## Outcome

- Added one host-configured filesystem snapshot store with immutable manifests,
  content-addressed UTF-8 blobs, opaque refs, and explicit resolution states.
- Shared the editor's project-root, ignore, exclusion, UTF-8, per-file, and
  path-limit policy without changing editor behavior.
- Added hard capture caps, streamed oversized-file hashing, binary/oversized
  metadata-only records, atomic writes, owner-only modes, deduplication, and
  active/awaiting-review/seven-day cleanup retention.
- Kept project files, SQLite, `ServerStateService`, task execution, Tauri, and
  UI outside this backend.

## Governing Refs

- `../../../contracts/008-storage-state-persistence-contract.md`
- `../../../contracts/021-checkpoint-diff-contract.md`
- `../../../specs/007-task-attributed-diff-review.md`

## Scope

- add a focused `nucleus-server` task-review snapshot module with separate
  types, capture, store, and retention files
- define opaque snapshot, manifest, blob, and file refs plus explicit coverage
  and resolution states
- reuse or extract the editor project-root containment, ignore, hard-exclusion,
  UTF-8, and 2 MiB text policy without changing editor behavior
- capture at most 5,000 admitted regular paths and 256 MiB retained text
- hash binary and oversized files without storing their bytes
- write immutable manifests and deduplicated BLAKE3-addressed text blobs outside
  the project with owner-only permissions
- implement active/awaiting-review retention and seven-day cleanup eligibility
- keep the backend root explicitly supplied by the host; do not add paths to
  `ServerStateService`

## Ordered Steps

1. Define serializable manifest and resolution records with opaque ids only.
2. Extract the minimum shared project admission helpers from editor authority.
3. Implement bounded capture and exact streamed hashing without following
   symlinks or crossing the canonical project root.
4. Implement atomic manifest/blob writes, deduplication, and owner-only modes.
5. Implement manifest resolution plus cleanup eligibility and orphan-safe
   startup sweep.
6. Add focused fixtures for unchanged, modified, added, deleted, binary,
   oversized, ignored, escaped, capped, deduplicated, expired, and missing data.

## Acceptance Criteria

- capture returns one immutable manifest ref and exact accepted coverage state
- eligible text is resolvable only through opaque refs inside the configured
  backend root
- binary and oversized bytes never enter blob storage
- ignored, hard-excluded, symlink-escaped, and over-limit inputs cannot become
  silently complete snapshots
- repeated content deduplicates without weakening manifest identity
- permissions, atomicity, expiry, missing, and cleanup states are tested
- no task execution, patch DTO, Tauri, or UI work enters this card

## Validation

- `effigy check:rust`
- focused snapshot backend tests through `effigy test`
- `cargo fmt --all -- --check`
- `git diff --check`

## Closure Evidence

- five focused snapshot fixtures cover boundary changes, ignored/excluded/
  escaped inputs, binary/oversized metadata, path-cap failure, content
  deduplication, opaque resolution, permissions, missing data, expiry, and
  orphan-safe cleanup
- implementation is isolated to `project_file_policy.rs` and the
  `task_review_snapshots/` module family, plus the editor helper extraction and
  crate export
- the project tree and `ServerStateService` shape are unchanged

## Stop Conditions

- safe storage requires project-local files or SCM mutation
- content bytes would enter SQLite or normal artifact metadata records
- shared policy extraction changes editor admission behavior
- owner-only filesystem permissions cannot be enforced on the desktop target

## Next

Auto-start card 155 after the backend contract is realized.
