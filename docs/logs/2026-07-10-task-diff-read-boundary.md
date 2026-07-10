# Task Diff Read Boundary

Date: 2026-07-10
Lane: G04 task-attributed diff review
Card: 156

## Outcome

- Typed overview requests expose durable changed-file metadata without loading
  source blobs or returning patch content.
- Typed file requests accept one opaque file ref and validate project, task,
  work-item, diff, checkpoint, and snapshot lineage before content resolution.
- `similar` 3.1.1 generates line-level unified patches with safe display-path
  headers and exact line additions/deletions.
- Binary, oversized, missing, expired, partial, and truncated states are
  explicit. Per-file input remains capped at 2 MiB; conservative bounded
  writing keeps the serialized response within 4 MiB even under JSON escaping.
- Dedicated Tauri commands and TypeScript helpers keep patches out of generic
  durable control responses and agent context.

## Evidence

- focused fixtures cover metadata-only overview, text patching, lineage
  refusal, binary, oversized, missing, expired, and long-line truncation
- responses contain no project, snapshot-store, or blob paths
- Rust/Tauri workspace compilation and 2,139 Effigy tests pass; 10 are skipped
- desktop TypeScript checking is currently blocked by 11 unrelated errors in
  linked Poodle `Rating`, `CardRadioGroup`, and `CardToggleGroup` sources

## Next

Replace the existing Diff placeholder with one compact changed-file review
surface using these dedicated reads and existing review-decision authority.
