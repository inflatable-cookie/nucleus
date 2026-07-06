# 006 Product Workflow Planning Context Composition

Status: ready
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing planning session and task seed records into the product workflow
summary.

## Work

- [ ] Locate existing server-side planning session and task seed projection
  helpers.
- [ ] Summarize counts and sanitized refs in `planning_context`.
- [ ] Remove the planning gap only when source records exist.
- [ ] Preserve invalid, missing, or unsupported planning records as explicit
  gaps.
- [ ] Add focused server/query/CLI tests for seeded and empty planning sources.

## Acceptance Criteria

- [ ] Planning records make the workflow planning band useful without raw
  payloads.
- [ ] Empty projects still report an honest planning gap.
- [ ] No task promotion, planning import/apply, projection write, provider
  execution, SCM mutation, or UI mutation is introduced.
