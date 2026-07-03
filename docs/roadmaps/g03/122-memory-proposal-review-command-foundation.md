# 122 Memory Proposal Review Command Foundation

Status: completed
Owner: Tom
Updated: 2026-07-03

## Purpose

Add the first bounded server-owned command lane for reviewing memory proposals.

This lane does not create authoritative accepted memory records. It only moves
proposal-side review/status metadata through explicit commands so humans and
future steward workflows can mark proposals as queued, deferred, rejected, or
reviewed for later promotion.

## Governing Refs

- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/server-client-query-surface-inventory.md`
- `docs/roadmaps/g03/119-planning-memory-proposal-foundation.md`
- `docs/roadmaps/g03/121-disposable-planning-research-ui-proof.md`

## Goals

- [x] Select the narrow memory proposal review command boundary.
- [x] Model review actions without creating accepted memory authority.
- [x] Persist proposal review/status changes through the existing server state
  boundary.
- [x] Expose read-only diagnostics for review command outcomes.
- [x] Add CLI/Effigy inspection before desktop controls.
- [x] Keep projection, embeddings, semantic search, provider-native memory
  sync, automatic extraction, and final UI out of scope.

## Execution Plan

- [x] Batch 1: select review command actions and no-effect rules.
- [x] Batch 2: add memory proposal review command model and validation.
- [x] Batch 3: persist reviewed proposal records without accepted-memory
  creation.
- [x] Batch 4: expose review diagnostics query/control/CLI/Effigy.
- [x] Batch 5: validate and choose whether desktop review controls are ready.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/532-memory-proposal-review-command-boundary.md`
- `batch-cards/533-memory-proposal-review-command-model.md`
- `batch-cards/534-memory-proposal-review-persistence.md`
- `batch-cards/535-memory-proposal-review-diagnostics-query-cli-effigy.md`
- `batch-cards/536-memory-proposal-review-validation-next-lane.md`

## Acceptance Criteria

- [x] Review commands can update proposal-side review/status metadata only.
- [x] Accepted memory records are not created.
- [x] Projection files are not written.
- [x] Provider, browser, SCM, forge, task, research execution, embedding, and
  semantic search effects remain absent.
- [x] The lane leaves a clear next decision between desktop review controls,
  planning import apply/review, research execution planning, or accepted memory
  authority.

## Next Lane

Selected: `123-planning-projection-import-review-apply.md`.

Reason:

- memory proposal review commands are now server-owned, inspected, and
  proposal-only
- accepted memory authority still needs accepted-memory storage, projection,
  retention, ranking, and privacy policy before mutation is useful
- research execution planning still needs retrieval/source policy before it can
  run safely
- desktop review controls would sit on a disposable UI while the project
  planning apply/review path is still incomplete
- planning projection import already has stopped candidates, admissions,
  conflict staging, diagnostics, and app-native planning records to apply into
  in a controlled way

Deferred:

- accepted memory record creation
- memory projection, embeddings, semantic search, provider-native memory sync,
  and automatic extraction
- final memory review UI
- research execution, crawling, browser automation, source retrieval, and
  model orchestration
- task promotion or creation from imported planning projections

## Stop Conditions

- The work requires defining accepted memory storage.
- The work requires repository projection, semantic search, or embeddings.
- The work requires autonomous memory extraction or provider-native memory
  sync.
- The work requires final UI design or desktop mutation controls before the
  server/CLI command path is proven.
