# 550 Planning Import Active Apply Executor Persistence

Status: paused
Owner: Tom
Updated: 2026-07-04
Milestone: `../125-planning-import-active-apply-executor-boundary.md`

## Purpose

Persist stopped executor plans and receipts without applying them.

## Work

- [ ] Store executor records under the planning state boundary.
- [ ] Use duplicate no-op handling for repeated executor ids.
- [ ] Preserve admission refs, revision expectations, and sanitized evidence
  refs.
- [ ] Withhold persistence for blocked/effect-widened records.

## Acceptance Criteria

- [ ] Executor records can be replayed and queried later.
- [ ] Active planning records are not mutated.
- [ ] Raw projected payloads and private planning bodies are not retained.

## Pause Note

Paused to avoid over-deepening the planning import lane before an end-to-end
apply proof shows the workflow is useful.
