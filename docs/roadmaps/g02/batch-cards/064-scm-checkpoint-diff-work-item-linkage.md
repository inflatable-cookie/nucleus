# 064 SCM Checkpoint Diff Work Item Linkage

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../017-scm-working-copy-and-change-request-workflows.md`

## Purpose

Link captured SCM changes to task work items, checkpoints, diffs, and runtime
receipts.

## Scope

- Add linkage records between SCM change sessions and task work items.
- Reference checkpoint and diff records by id.
- Preserve provider-neutral change refs.
- Do not publish or merge changes.

## Acceptance Criteria

- [x] A task work item can reference captured SCM change evidence.
- [x] Checkpoint/diff refs stay separate from Git commits.
- [x] Missing or superseded change refs surface as repair state.

## Outcome

Added `nucleus-engine::scm_work_item_linkage` as an engine-owned,
reference-only linkage surface.

The records link task work items to SCM work session ids, provider-neutral
change refs, checkpoint ids, diff summary ids, and runtime receipt ids. Work
item refs now carry diff summary ids separately from checkpoint ids.

Missing and superseded SCM change refs are explicit repair states. The
implementation does not publish, merge, open review requests, or call forge
APIs.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo test -p nucleus-engine checkpoint`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if linkage requires forge publication semantics.
