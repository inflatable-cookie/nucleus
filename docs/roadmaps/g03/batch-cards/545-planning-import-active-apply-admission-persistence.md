# 545 Planning Import Active Apply Admission Persistence

Status: planned
Owner: Tom
Updated: 2026-07-03
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Persist active-apply admission records without executing apply.

## Work

- [ ] Store admission records under the planning state boundary.
- [ ] Use duplicate no-op handling for repeated admission ids.
- [ ] Preserve revision expectations, approval refs, and sanitized evidence refs.
- [ ] Reject or withhold persistence for blocked/effect-widened records.

## Acceptance Criteria

- [ ] Admission records can be replayed/queried later.
- [ ] Active planning records are not mutated.
- [ ] Raw projected file payloads and private planning bodies are not retained.
