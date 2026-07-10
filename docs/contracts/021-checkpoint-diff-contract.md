# 021 Checkpoint Diff Contract

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Define change boundaries for reviewing, reverting, merging, publishing, and
explaining work.

Checkpoints and diffs connect tasks, agent turns, SCM state, worktrees,
artifacts, and user review.

## Checkpoint Rule

A checkpoint is a Nucleus change boundary.

It may be backed by Git commits, Git worktree state, Convergence snapshots,
provider-native checkpoints, filesystem snapshots, artifact manifests, or a
custom SCM adapter capability.

Do not assume every checkpoint is a Git commit.

## Ownership Rule

Checkpoints may attach to:

- task work item
- agent session
- thread
- turn
- SCM/change workflow
- validation run
- research run
- steward operation
- manual user operation

Checkpoint ownership must be explicit. A checkpoint may have multiple refs, but
one primary workflow owner should be recorded for review and recovery.

## Checkpoint Fields

Minimum fields:

- checkpoint id
- checkpoint family
- primary workflow ref
- project id
- repo or source ref where applicable
- SCM adapter ref where applicable
- authority host id
- created by actor ref
- causal command or event refs
- parent checkpoint refs
- artifact refs
- summary
- recovery state

## First Checkpoint Implementation

The first implementation is a record foundation only.

Implemented checkpoint records carry:

- checkpoint id
- checkpoint family
- primary workflow ref
- project ref
- optional source ref
- optional SCM adapter ref
- authority host ref
- created-by actor ref
- causal refs
- parent checkpoint refs
- artifact refs
- summary
- recovery state

The engine owns the neutral record vocabulary and JSON codec. The server stores
the first records as typed artifact metadata and exposes read-only list queries.

This implementation does not capture snapshots, create branches or worktrees,
run SCM mutations, or publish change requests.

## Diff Rule

A diff is a view between two change boundaries.

Diffs may be:

- source diff
- management projection diff
- task state diff
- memory projection diff
- planning artifact diff
- research synthesis diff
- artifact manifest diff
- custom

Diff records should preserve enough metadata to identify source, target,
adapter capability, generation method, and confidence.

## First Diff Summary Implementation

The first implementation is a summary record, not a patch format.

Implemented diff summary records carry:

- diff id
- diff kind
- source boundary ref
- target boundary ref
- optional source ref
- optional adapter ref
- generated-by ref
- confidence
- summary
- changed paths
- evidence refs
- artifact refs

The first control API exposes read-only list queries for checkpoint and diff
summary records. It does not expose raw patches, terminal streams, provider
payloads, or SCM credentials.

## Task Review Source Snapshot Boundary

The first task-attributed source review uses two immutable host-owned source
snapshots:

- a baseline captured after task run admission and before provider dispatch
- a target captured when runtime work has completed and before awaiting review

Both checkpoints name the task work item as their primary workflow owner. This
is task-window attribution, not forensic actor attribution. Writes by another
local actor during the execution window are included and the review surface
must disclose that limitation.

The first source-snapshot backend is host-local and SCM-neutral. It stores an
immutable manifest outside the project repository and repo-backed management
projection. Manifest entries contain a safe project-relative path, exact
content hash, size, text/binary classification, content availability, and
coverage state. Eligible text bytes are deduplicated behind content-addressed
blob refs with owner-only filesystem permissions. Binary and oversized content
is represented by hash and size only.

The initial policy reuses editor containment, ignore, hard-exclusion, UTF-8,
and 2 MiB per-text-file rules. A capture admits at most 5,000 paths and 256 MiB
of retained text. Exceeding a hard limit or losing project containment makes
capture unavailable; it must not silently produce a partial baseline for a
write-capable task run.

Snapshot refs remain resolvable while their work item is active or awaiting
review. Terminal review starts a seven-day cleanup grace. Missing, expired,
partial, unsupported, and cleanup-pending states remain explicit in durable
summary records even after detailed blobs are unavailable.

This boundary does not invoke Git, create SCM objects, change refs or indexes,
copy snapshots into the project, or make source snapshots shared project state.

## Transient Patch Query Boundary

Detailed patch content is a bounded read view resolved from one accepted diff
ref and its exact baseline and target snapshots. Patch bytes are not added to
`EngineDiffSummaryRecord` and are not durable task, timeline, command-evidence,
chat, or management-projection fields.

The read request contains:

- project id
- task work-item id
- diff ref
- optional opaque changed-file ref

The response may contain:

- baseline and target checkpoint refs
- safe project-relative display path and opaque file ref
- added, modified, deleted, or metadata-only change kind
- bounded unified text patch
- additions and deletions when exact
- binary, oversized, truncated, unavailable, expired, or partial state
- coverage and concurrent-write attribution notice

The first response is capped at 2 MiB per text file and 4 MiB total. The host
may return a smaller explicit truncation result. Absolute project paths,
snapshot storage paths, blob paths, credentials, terminal output, and provider
payloads must never enter the response.

Patch generation is read-only. It must not mutate source files, snapshots, SCM
state, task state, or review state. Patch content is not sent to an agent or
model unless a later explicit, separately admitted context action allows it.

## SCM Work Item Linkage

SCM evidence linkage is an engine-owned reference record.

It may link:

- task id
- task work item id
- SCM work session id
- provider-neutral SCM change refs
- checkpoint ids
- diff summary ids
- runtime receipt ids

Checkpoint ids and diff summary ids must stay separate from provider change
refs. A Git commit, Convergence snapshot, publication, or provider-equivalent
change ref may be evidence for a work item, but it must not replace the
checkpoint or diff summary records Nucleus uses for review and recovery.

Missing and superseded SCM change refs are repair states. They must not imply
task completion, publication, merge, or review approval.

## Change Request Prep Linkage

Change-request prep records may reuse checkpoint ids, diff summary ids,
runtime receipt ids, SCM work session ids, and provider-neutral change refs as
handoff evidence.

Prep records are not publication records. They may name an intended forge
review, provider publication, provider gate, direct authority update, manual
handoff, or custom target, but they must keep publication state separate from
the review evidence.

Diff summaries and checkpoints remain the Nucleus review boundary even when a
later provider operation creates a pull request, merge request, publication,
gate input, or direct authority update proposal.

## SCM Neutrality Rule

The contract uses neutral terms:

- checkpoint
- snapshot
- publication
- change request
- review
- integration
- rollback
- repair

Git commits, branches, worktrees, pull requests, and merges are adapter-specific
implementations of those concepts. Convergence snapshots and publication flows
must fit without pretending they are Git commits.

## Review Rule

User review should operate on checkpoint and diff refs, not raw provider
transcripts.

Review surfaces may show:

- files changed
- management records changed
- task state changed
- summary
- validation receipts
- related messages or activities
- SCM/forge publication state

Review surfaces must not become the authority for change state.

Task-backed review acceptance sequencing is owned by
`023-task-backed-agent-workflow-contract.md`. This contract owns the checkpoint
and diff evidence boundaries used by that review.

## Revert Rule

Revert is an orchestrated workflow.

A revert request must identify:

- target checkpoint or diff
- desired recovery target
- affected authority domains
- expected SCM adapter behavior
- policy scope
- review requirement

Raw `git reset`, provider rollback, or filesystem restore must not be treated
as a universal implementation.
