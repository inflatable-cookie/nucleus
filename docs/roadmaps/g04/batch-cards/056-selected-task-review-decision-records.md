# 056 Selected Task Review Decision Records

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Persist review-decision records and surface them through existing selected-task
read models.

## Work

- [x] Add sanitized review-decision records to the local store.
- [x] Store action, operator ref, evidence refs, expected revision, outcome,
  reason summary, receipt refs, and idempotency key.
- [x] Add timeline refs for accepted decisions.
- [x] Refresh selected-task review/next-step and SCM handoff readiness from the
  new records.

## Acceptance Criteria

- [x] Decision records are append-only from the read-model perspective.
- [x] Replays and duplicate idempotency keys remain stable.
- [x] Existing selected-task read models can explain decision state.
- [x] Task lifecycle, provider, SCM, memory, planning, and final UI behavior
  remain untouched.

## Result

Added `selected_task_review_decision_records` as a modular persistence surface
with `store`, `types`, and `tests` files.

Persisted records are sanitized and include decision id, admission id, project
id, task id, work-item refs, action, outcome, operator ref, expected revision,
reviewed evidence refs, receipt refs, timeline refs, reason summary,
idempotency key, persistence status, blockers, duplicate marker, and explicit
no-effect flags.

Task workflow drilldown now reads persisted selected-task review decisions and
refreshes:

- work-progress review status
- review refs
- accepted-decision timeline refs

Selected-task review/next and SCM handoff readiness consume that refreshed
drilldown state without direct provider, SCM, memory, planning, task lifecycle,
or UI effects.

Focused validation passed:

- `cargo test -p nucleus-server selected_task_review_decision -- --nocapture`
- `cargo test -p nucleus-server task_workflow_drilldown_query_refreshes_from_selected_task_review_decision_records -- --nocapture`
