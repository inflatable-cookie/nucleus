# 520 Deep Research Run Brief Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Select the first bounded deep research run brief slice.

## Work

- [x] Confirm the research run brief boundary from contract `015`.
- [x] Identify which refs belong in the first model.
- [x] Name deferred execution, retrieval, projection, promotion, and UI
  surfaces before code starts.
- [x] Update inventory if the boundary changes crate expectations.

## Acceptance Criteria

- [x] The selected boundary is narrow enough for a focused crate.
- [x] Research run briefs are distinct from active research execution.
- [x] Raw source payloads, raw transcripts, provider payloads, credentials,
  secret-bearing files, private notes, crawler output, and browser caches are
  explicitly excluded.
- [x] No code behavior is added.

## Decision

Selected first boundary:

- focused crate: `nucleus-research`
- first records: research run brief ids, optional project refs, title, brief,
  status, scope boundary, source plan refs, confidence, coverage summary, and
  timestamps
- first refs: source plan refs only, with question/source/observation/synthesis
  refs deferred to the next cards

Deferred:

- crawler implementation
- browser automation
- search provider selection
- source retrieval
- model/provider execution
- citation rendering
- raw source retention
- accepted synthesis promotion
- accepted memory mutation
- planning/task/docs projection or apply
- task creation
- UI behavior
- embeddings and semantic search
- SCM/forge mutation

## Stop Conditions

- The work requires choosing crawler, browser automation, search provider,
  model orchestration, citation rendering, or quote-retention policy.
- The work requires accepting research into memory, planning, tasks, docs, or
  projection files.
- The work requires provider, task, browser, SCM, forge, or UI effects.
