# 160 Rework Run Provenance And Provider Context

Status: completed
Owner: Codex
Updated: 2026-07-11
Milestone: `../030-review-guided-rework-execution.md`
Auto-start next card: yes

## Objective

Turn a fresh task-scoped operator mandate into a new rework work item carrying
the reviewed decision, prior work, evidence, and review note.

## Scope

- admit rework only for rejected or Needs changes current review state
- preserve the normal fresh mandate, task revision, and idempotency gates
- freeze rework provenance into the run/work-item source state
- include the durable note in provider instructions without patch content
- capture a fresh baseline, target, diff, and reviewable result
- do not widen Goal runs in this card

## Acceptance Criteria

- review state alone never starts execution
- new work item identity differs from reviewed work
- prior records remain unchanged and linked by reference
- duplicate/stale/refused runs fail closed
- successful output is independently reviewable

## Validation

- focused admission, prompt, provenance, duplicate, and lifecycle tests
- `effigy test`
- `git diff --check`

## Next

Auto-start card 161 after the rework run is authoritative and reviewable.

## Outcome

- A task-scoped run now derives rework only from the current durable rejected
  or Needs changes decision and refuses accepted or mismatched context.
- The admitted work item retains decision, prior work-item, and reviewed
  evidence refs. The persisted run plan freezes the same context.
- Provider instructions include the durable note and opaque refs, explicitly
  excluding patch interpretation. Existing execution creates the fresh
  baseline, target, diff, and reviewable work-item result.
- Seven focused portal, prompt, inspection, and admission tests pass.
