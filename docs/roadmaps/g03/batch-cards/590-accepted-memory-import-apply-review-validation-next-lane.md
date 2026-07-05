# 590 Accepted Memory Import Apply Review Validation Next Lane

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Validate accepted-memory import-apply review commands and choose the next
bounded lane.

## Work

- [ ] Run focused review command and diagnostics tests.
- [ ] Run relevant package checks, docs QA, Northstar QA, diff check, doctor,
  and format check.
- [ ] Decide whether the next lane is active accepted-memory apply, SCM share,
  search planning, provider sync planning, automatic extraction planning, final
  UI planning, or a broader rebaseline.

## Acceptance Criteria

- [ ] Validation passes or failures are documented.
- [ ] The next lane remains effect-gated.
- [ ] Active accepted-memory mutation, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, and final UI behavior remain out of scope unless explicitly
  selected.
