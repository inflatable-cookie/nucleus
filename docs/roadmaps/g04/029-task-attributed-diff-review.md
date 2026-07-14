# 029 Task Attributed Diff Review

Status: completed
Owner: Tom
Updated: 2026-07-10

## Purpose

Connect task-backed agent execution to one trustworthy, compact source review
surface without presenting pre-existing working-copy changes as task work.

## Generation Runway Fit

This lane advances G04 from task execution plus a standalone editor into the
first complete operator review loop: an admitted task captures its source
window, runs through the existing provider route, exposes exact bounded change
evidence, and accepts an admitted review decision without adding SCM mutation
or IDE chrome.

## Governing Refs

- `../../specs/007-task-attributed-diff-review.md`
- `../../architecture/system-architecture.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/021-checkpoint-diff-contract.md`
- `../../contracts/023-task-backed-agent-workflow-contract.md`

## Goals

- [x] Implement bounded immutable host-local source snapshots with explicit
  coverage and retention state.
- [x] Capture baseline and target checkpoints around every write-capable task
  execution before it becomes reviewable.
- [x] Compose task-owned diff summaries and bounded transient unified patches.
- [x] Replace the Diff placeholder with one compact review panel linked to the
  Editor and existing review-decision authority.
- [x] Validate attribution, failure recovery, UI simplicity, and non-mutation
  boundaries end to end.

## Boundary

This lane may:

- add one filesystem-backed task review snapshot backend under host-local
  Nucleus data
- store immutable manifests and deduplicated policy-admitted text blobs
- link checkpoint and diff-summary refs to task work-item source records
- use `similar` 3.1.1 with default text features for bounded unified patches
- add typed task diff list/read commands and DTOs
- render one changed file at a time in the existing Diff panel
- reuse accepted selected-task review decisions and focus/create the Editor

This lane must not:

- mutate Git, another SCM, project files, snapshots, or provider state from the
  Diff surface
- add staging, commits, branches, worktrees, hunk apply/revert, merge editing,
  publication, or task completion
- call a whole working-copy diff task-attributed
- persist patch bytes in SQLite, task history, chat, command evidence, or
  management projection
- send patch content to agents/models automatically
- add a permanent changes sidebar, source-control workbench, or editor tabs

## Execution Plan

- [x] Batch 1: source snapshot domain, filesystem backend, capture policy,
  deduplication, and retention lifecycle.
- [x] Batch 2: pre-dispatch baseline, post-runtime target, checkpoint/diff
  persistence, and work-item linkage.
- [x] Batch 3: transient patch read API, Tauri DTOs, compact Diff panel, Editor
  navigation, and existing review-decision controls.
- [x] Batch 4: full task-run attribution, recovery, interaction, visual, and
  regression validation.

## Acceptance Criteria

- [x] Pre-existing source state exists in both boundaries and is absent from
  the task-window diff.
- [x] Provider dispatch cannot start when the baseline capture fails.
- [x] Runtime completion cannot become reviewable when target capture or diff
  persistence fails.
- [x] Snapshot bytes stay outside the project and durable record payloads with
  owner-only permissions and bounded retention.
- [x] Patch queries validate task/work-item/diff lineage and expose no absolute
  or backend paths.
- [x] Diff review shows partial, binary, oversized, truncated, missing, and
  expired states honestly.
- [x] Accept and Needs changes cite the exact reviewed evidence through existing
  server authority and do not complete the task.
- [x] The normal panel remains one quiet changed-file review surface.

## Planning Gaps Beyond This Lane

- isolated task workspaces for forensic actor attribution
- binary/image diff renderers
- hunk selection or source mutation
- SCM staging, capture, publication, and merge workflow
- remote snapshot transport and multi-client access policy
- automatic review-context selection for agents

These gaps do not block an exact local task-window review.

## Batch Cards

Ready:

- None.

Planned:

- None.

Completed:

- `batch-cards/158-task-diff-review-validation-and-closeout.md`
- `batch-cards/157-compact-task-diff-review-panel.md`
- `batch-cards/156-task-diff-read-api-and-tauri-boundary.md`
- `batch-cards/155-task-run-checkpoint-diff-integration.md`
- `batch-cards/154-task-review-source-snapshot-backend.md`

## Checkpoint

After card 158, stop for operator review of the complete task-attributed review
loop. Do not infer SCM mutation, isolated workspaces, or patch-to-agent priority
from this lane.
