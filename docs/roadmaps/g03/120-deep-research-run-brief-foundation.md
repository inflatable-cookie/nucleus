# 120 Deep Research Run Brief Foundation

Status: active
Owner: Tom
Updated: 2026-07-03

## Purpose

Create the first app-native deep research run brief foundation without building
crawlers, browser automation, source retrieval, model orchestration, citation
rendering, projection/apply, accepted memory promotion, task creation, or UI.

The memory proposal lane gives research findings somewhere safe to land later.
This lane creates the smallest useful research domain: run ids, project-bound
or standalone scope, research brief records, question records, source refs,
observation refs, synthesis refs, confidence/coverage summary, storage shape,
and read-only diagnostics.

## Governing Refs

- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/026-open-ended-planning-conversation-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g03/119-planning-memory-proposal-foundation.md`

## Goals

- [x] Select the narrow research run brief boundary.
- [x] Add a focused `nucleus-research` crate instead of extending broad server
  modules.
- [x] Model research run ids, run status, scope boundary, brief text, source
  plan refs, confidence, coverage, and timestamps.
- [ ] Model research questions, source refs, observation refs, synthesis refs,
  memory proposal refs, planning artifact refs, and task seed refs as refs
  only.
- [ ] Add JSON storage codec for research run brief records.
- [ ] Expose read-only server/query/CLI/Effigy inspection if the storage shape
  is stable.
- [ ] Keep crawling, browser automation, provider execution, model
  orchestration, source retrieval, raw source retention, projection/apply,
  accepted memory promotion, task creation, UI behavior, embeddings, semantic
  search, and SCM/forge mutation out of scope.

## Execution Plan

- [x] Batch 1: select the research run brief boundary and deferred surfaces.
- [x] Batch 2: add `nucleus-research` crate front door and module skeleton.
- [x] Batch 3: add research run brief value records.
- [ ] Batch 4: add research question and source ref records.
- [ ] Batch 5: add observation/synthesis linkage and promotion target refs.
- [ ] Batch 6: add storage codec and local-store shape.
- [ ] Batch 7: expose read-only server/query/CLI/Effigy inspection if storage
  is ready.
- [ ] Batch 8: validate and choose whether the next lane is accepted memory
  review commands, research execution planning, planning import apply/review,
  or a disposable planning/research UI proof.

## Batch Cards

Ready cards:

- `batch-cards/523-research-question-source-ref-records.md`

Planned cards:

- `batch-cards/524-research-observation-synthesis-linkage.md`
- `batch-cards/525-research-run-brief-storage-codec.md`
- `batch-cards/526-research-run-brief-query-cli-effigy.md`
- `batch-cards/527-deep-research-run-brief-validation-next-lane.md`

Completed cards:

- `batch-cards/522-research-run-brief-record-types.md`
- `batch-cards/521-nucleus-research-crate-front-door.md`
- `batch-cards/520-deep-research-run-brief-boundary-selection.md`

## Acceptance Criteria

- [x] Research run brief records are owned by a focused crate.
- [ ] Research output remains evidence until explicitly promoted.
- [ ] Questions, sources, observations, synthesis, memories, planning
  artifacts, and task seeds are linked through refs only.
- [ ] Raw browser caches, copyrighted source payloads, raw transcripts,
  provider payloads, private notes, credentials, and secret-bearing files are
  excluded.
- [ ] No crawling, browser automation, source retrieval, provider execution,
  model orchestration, accepted memory promotion, task creation,
  projection/apply, UI behavior, embedding, semantic search, or SCM/forge
  effect is added.

## Stop Conditions

- The work requires choosing a search provider, crawler, browser automation
  policy, or model orchestration policy.
- The work requires retaining raw source payloads or copyrighted content.
- The work requires citation rendering or quote-retention policy.
- The work requires accepting research into planning, memory, tasks, docs, or
  projection files.
- The work requires executing provider, task, browser, SCM, forge, or UI
  effects.

## Boundary Decision

Deep research run brief foundation is the next useful lane because it lets
planning and future research work capture structured research intent and
evidence refs before any autonomous research execution exists.

Deferred surfaces:

- crawler implementation
- browser automation
- source retrieval
- provider/model execution
- research scheduler
- raw source retention
- citation renderer
- accepted synthesis promotion
- accepted memory mutation
- task creation
- projection/apply
- final research UI

Rationale:

- memory proposals can now receive research findings later
- accepted memory commands should wait until research and planning outputs can
  produce reviewed evidence
- planning import apply/review should wait until more project-management
  records exist to import safely
- UI proof should wait until research run brief inspection exists
