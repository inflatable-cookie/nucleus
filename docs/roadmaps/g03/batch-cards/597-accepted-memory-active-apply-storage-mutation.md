# 597 Accepted Memory Active Apply Storage Mutation

Status: superseded
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Implement the minimal server-local accepted-memory mutation behind admitted
active-apply authority.

## Superseded Reason

Deferred by `../../g04/001-product-workflow-rebaseline-and-vertical-slice.md`.
Return through `docs/roadmaps/deferred-lanes.md` after the project/task/agent
workflow proves that active accepted-memory apply is needed.

## Work

- [ ] Map admitted active-apply authority to accepted-memory storage records.
- [ ] Create or update only server-local accepted-memory records.
- [ ] Return duplicate no-op when existing accepted memory already matches.
- [ ] Preserve sanitized source refs, provenance refs, evidence refs,
  sensitivity, retention, and review state.
- [ ] Add focused local-store tests.

## Acceptance Criteria

- [ ] Only accepted-memory local-store records are mutated.
- [ ] Duplicate no-op is idempotent.
- [ ] Blocked, stale, missing-ref, and effect-widened inputs do not mutate.
- [ ] No projection, SCM/forge, search/provider-sync, extraction, task, agent,
  callback/interruption/recovery, raw payload, or UI effect is added.
