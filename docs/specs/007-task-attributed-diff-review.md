# Task Attributed Diff Review

Status: promoted-first-pass
Owner: Tom
Updated: 2026-07-10

## Purpose

Connect task-backed agent execution to one trustworthy, compact review surface
without confusing pre-existing working-copy changes with the task run.

## Scope

The first slice captures one project source boundary immediately before a
write-capable task work item is dispatched and a second boundary when runtime
work becomes reviewable. The resulting diff belongs to that work item and task
review window.

Task attribution means the change window is owned by the task work item. It is
not forensic proof that every byte was written by the agent. Concurrent host or
operator writes during the window are included and must be disclosed.

The slice includes:

- bounded host-local source snapshot manifests and content-addressed text blobs
- immutable baseline and target checkpoint refs on the task work item
- one diff summary plus changed-file metadata
- bounded transient patch generation from the two accepted snapshots
- one real Diff panel with compact changed-file quick open
- existing admitted accept and needs-changes review actions behind compact UI
- navigation from a changed file to the Editor panel

The slice excludes:

- generic whole-working-copy review presented as task-attributed
- Git staging, commits, branches, worktrees, reset, checkout, or stash
- hunk apply/revert, merge conflict editing, or patch mutation
- automatic review acceptance or task completion
- patch persistence in task records, timelines, chat, or management projection
- automatic patch delivery to an agent or model
- binary content rendering, image diff, or files outside snapshot policy

## Settled Decisions

### Review boundary

- baseline capture occurs after run admission and before provider dispatch
- target capture occurs before a completed work item becomes awaiting review
- write-capable dispatch fails closed if the baseline cannot be captured
- missing or failed target capture produces recovery-required review evidence,
  not an empty or accepted diff
- baseline and target refs remain distinct from provider change refs

### Snapshot storage

- the authoritative host owns an immutable source-snapshot backend outside the
  project repository and normal management projection
- manifests use safe project-relative paths, exact content hashes, size, text
  classification, and coverage state
- eligible text content is stored as deduplicated content-addressed blobs with
  owner-only filesystem permissions
- the first policy reuses editor ignore, hard-exclusion, containment, UTF-8,
  and 2 MiB per-text-file rules
- binary and oversized regular files retain hash/size metadata only; their
  content is never copied into the first snapshot store
- the first capture admits at most 5,000 paths and 256 MiB of retained text;
  exceeding a hard capture limit blocks write-capable dispatch
- snapshots remain resolvable while the work item is active or awaiting review
  and enter a seven-day cleanup grace after terminal review

### Patch delivery

- durable records contain checkpoint refs, summary, paths, counts, confidence,
  truncation, and evidence refs only
- a read-only host query resolves one diff ref and optional file ref into a
  transient patch response
- the first response is capped at 2 MiB per text file and 4 MiB total
- patch responses carry only safe display paths and opaque refs; no absolute
  snapshot/blob paths are exposed
- binary, oversized, expired, partial, and unavailable states are explicit
- patch content is not stored in SQLite, command evidence, task history, chat,
  or repo-backed projection and is not sent to models automatically

### Product UI

- the existing Diff panel becomes the review surface; no new permanent region
  or source-control sidebar is added
- normal presentation is one summary line, one compact changed-file trigger,
  one read-only file diff, and one small review menu
- changed-file metadata and recovery detail stay in the file popover or review
  menu
- Accept and Needs changes reuse server-owned task review admission and cite
  the exact work-item revision and evidence refs
- review actions do not complete the task, publish SCM state, or mutate files
- Open in Editor focuses or creates the existing Editor panel for the selected
  project-relative file

## Acceptance Criteria

- pre-existing project changes are present in both boundaries and therefore do
  not appear as task-window changes
- a task cannot claim reviewable source changes without accepted baseline and
  target checkpoint refs
- concurrent writes are disclosed as part of the task window rather than
  falsely attributed to the agent actor
- rejected, partial, binary, oversized, missing, and expired evidence remains
  explicit
- the Diff panel stays visually simpler than a source-control workbench
- clients cannot traverse snapshot storage or mutate source/SCM state through
  patch queries
- accepting or requesting changes goes through existing review authority

## Promotion Targets

Durable outcomes are promoted into:

- `docs/architecture/system-architecture.md`
- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/006-workspace-layout-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`

Roadmap compilation follows promotion.
