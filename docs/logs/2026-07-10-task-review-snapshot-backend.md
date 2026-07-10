# Task Review Snapshot Backend

Date: 2026-07-10
Lane: G04 task-attributed diff review
Card: 154

## Outcome

- `nucleus-server` now owns an immutable host-local task review snapshot store.
- Manifests retain safe relative paths, exact hashes, sizes, content classes,
  opaque refs, coverage, task ownership, and baseline/target role.
- Admitted UTF-8 text is deduplicated behind BLAKE3-addressed blobs. Binary and
  oversized bytes are never copied into the store.
- Capture reuses the editor's containment, ignore, hard-exclusion, UTF-8,
  2 MiB, and 5,000-path policy. Retained text is capped at 256 MiB.
- Manifests, blobs, retention records, and directories use atomic writes and
  owner-only modes under a host-supplied root outside the project.
- Active and awaiting-review snapshots remain available. Terminal review
  enters a seven-day grace before manifests and unreferenced blobs expire.

## Evidence

- five focused backend fixtures pass across exact boundary changes, metadata-
  only files, exclusions, deduplication, opaque reads, modes, caps, expiry, and
  orphan cleanup
- the existing editor authority fixture passes after shared-policy extraction
- the full Effigy run passes: 2,133 tests, with 10 skipped
- Rust workspace check, formatting, docs QA, and diff hygiene pass
- project contents and `ServerStateService` remain unchanged

## Next

Integrate baseline and target capture around each write-capable task run, then
persist task-owned checkpoint and diff summaries before review readiness.
