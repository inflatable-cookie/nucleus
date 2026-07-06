# 600 Accepted Memory Active Apply Validation Next Lane

Status: superseded
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Validate the minimal active accepted-memory apply lane and select the next
bounded lane.

## Superseded Reason

Deferred by `../../g04/001-product-workflow-rebaseline-and-vertical-slice.md`.
The next validation checkpoint is now the g04 product workflow slice, not
continued accepted-memory mutation.

## Work

- [ ] Run focused active-apply executor, receipt persistence, diagnostics,
  DTO, CLI, and selector tests.
- [ ] Run relevant package checks, docs QA, Northstar QA, diff check, doctor,
  and format check.
- [ ] Decide whether the next lane is projection share, SCM share,
  embeddings/search planning, provider-native memory sync planning, automatic
  extraction planning, final memory UI planning, or rebaseline.

## Acceptance Criteria

- [ ] Validation passes or failures are documented.
- [ ] The next lane remains effect-gated.
- [ ] Projection writes, SCM/forge mutation, embeddings/search/provider sync,
  automatic extraction, task mutation, agent scheduling,
  callback/interruption/recovery, and final UI behavior remain out of scope
  unless explicitly selected.
