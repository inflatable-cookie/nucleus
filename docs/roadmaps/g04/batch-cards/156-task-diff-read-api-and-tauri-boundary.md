# 156 Task Diff Read API And Tauri Boundary

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../029-task-attributed-diff-review.md`
Auto-start next card: yes

## Objective

Expose task-owned changed-file metadata and bounded transient unified patches
through typed host and Tauri read boundaries.

## Outcome

- Added dedicated overview and one-file patch DTOs that accept only project,
  task, work-item, diff, and opaque file refs.
- Every read validates durable work-item, checkpoint, diff, project, and task
  lineage before snapshot resolution.
- Overview reads return metadata only. Patch reads resolve one authorized file
  and generate line-level unified output with `similar` 3.1.1.
- Binary, oversized, missing, expired, partial, and truncated states remain
  explicit. Text inputs stay within 2 MiB and the serialized response is
  conservatively bounded below 4 MiB.
- Dedicated Tauri commands and TypeScript helpers expose the read boundary
  without adding patch bytes to generic control envelopes or agent context.

## Governing Refs

- `../../../contracts/007-server-boundary-contract.md`
- `../../../contracts/021-checkpoint-diff-contract.md`
- `155-task-run-checkpoint-diff-integration.md`

## Scope

- add typed task diff overview and file-patch requests/responses
- validate project, task, work-item, baseline, target, and diff lineage against
  authoritative records before resolving snapshot content
- use Apache-2.0 `similar` 3.1.1 default text support for line-level unified
  patches and exact addition/deletion counts
- cap each text patch at 2 MiB and each response at 4 MiB with explicit
  truncation
- return safe display paths, opaque refs, change kind, counts, coverage,
  attribution notice, and binary/oversized/missing/expired/partial states
- expose typed Tauri commands and TypeScript helpers; keep patch bytes out of
  generic durable control envelopes
- keep arbitrary snapshot/blob resolution and client path input impossible

## Ordered Steps

1. Add focused Rust DTO and lineage-validation modules.
2. Compose the overview from durable records without resolving all blobs.
3. Resolve one opaque changed-file ref into authorized baseline/target text.
4. Generate bounded unified output with safe headers and explicit truncation.
5. Add typed Tauri commands and client helpers.
6. Add serialization, lineage refusal, size, binary, expiry, and no-path-leak
   tests.

## Acceptance Criteria

- overview reads do not load or expose patch content
- patch reads require exact authoritative task/work-item/diff lineage
- no request accepts an absolute or project-relative filesystem path
- headers contain safe display paths only
- output caps cannot be bypassed by long lines or missing newlines
- binary, oversized, missing, expired, partial, and truncated are distinct
- reads mutate no source, snapshot, SCM, task, or review state
- patch content enters no persistence or agent context surface

## Validation

- `effigy check:rust`
- focused API/DTO/Tauri tests through `effigy test`
- `effigy desktop:check`
- `git diff --check`

## Closure Evidence

- focused fixtures cover metadata-only overview, exact text patch, lineage
  refusal, binary, oversized, missing, expired, long-line truncation, response
  size, and absolute-path non-disclosure
- safe unified headers use only sanitized manifest-derived display paths
- implementation is isolated to `task_diff_read/`, two dedicated Tauri
  commands, and one TypeScript control helper
- full Effigy validation passes 2,139 tests with 10 skipped
- desktop TypeScript checking is externally blocked by 11 current linked-Poodle
  errors in `Rating`, `CardRadioGroup`, and `CardToggleGroup`

## Stop Conditions

- patch delivery requires arbitrary blob or filesystem access
- response bounding cannot be enforced before allocation or serialization
- the generic command receipt would need to persist patch bytes
- the selected diff dependency introduces incompatible licensing or runtime
  requirements

## Next

Auto-start card 157 after the read boundary is typed and bounded.
