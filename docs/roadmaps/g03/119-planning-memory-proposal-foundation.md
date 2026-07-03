# 119 Planning Memory Proposal Foundation

Status: completed
Owner: Tom
Updated: 2026-07-03

## Purpose

Create the first app-native shared memory proposal foundation that attaches to
planning sessions, exploration output, accepted planning artifacts, research
brief refs, and task seeds without implementing embeddings, autonomous
extraction, final review UI, provider-native memory sync, or projection/apply.

The previous lane proved structured planning records and read-only inspection.
This lane adds the smallest useful memory boundary: proposed memory records,
review state, sensitivity, retention posture, source refs, storage shape, and
read-only diagnostics. Accepted memory authority, semantic search, embeddings,
and automatic extraction stay deferred.

## Governing Refs

- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/026-open-ended-planning-conversation-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g03/118-structured-planning-domain-foundation.md`

## Goals

- [x] Select the narrow memory proposal boundary.
- [x] Add a focused `nucleus-memory` crate instead of extending broad server
  modules.
- [x] Model memory proposal ids, scopes, kinds, statuses, source refs,
  sensitivity, confidence, retention posture, and review state.
- [x] Link memory proposals to planning sessions, exploration sessions,
  accepted artifacts, research briefs, task seeds, tasks, and source evidence
  through refs only.
- [x] Add JSON storage codec for memory proposal records.
- [x] Add read-only server/query/CLI/Effigy inspection if the storage shape is
  stable.
- [x] Keep embeddings, semantic search, autonomous extraction, provider-native
  memory sync, final UI, task creation, planning mutation, projection apply,
  provider execution, and SCM/forge mutation out of scope.

## Execution Plan

- [x] Batch 1: select the memory proposal boundary and deferred surfaces.
- [x] Batch 2: add `nucleus-memory` crate front door and module skeleton.
- [x] Batch 3: add memory proposal value records and source refs.
- [x] Batch 4: add review, sensitivity, confidence, and retention records.
- [x] Batch 5: add planning/research/task linkage and storage codec.
- [x] Batch 6: expose read-only server/query/CLI/Effigy inspection if storage
  is ready.
- [x] Batch 7: validate and choose whether the next lane is deep research run
  briefs, accepted memory review commands, planning import apply, or a
  disposable planning/memory UI proof.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/519-memory-foundation-validation-next-lane.md`
- `batch-cards/518-memory-proposal-query-cli-effigy.md`
- `batch-cards/517-memory-planning-linkage-storage-codec.md`
- `batch-cards/516-memory-review-sensitivity-retention-records.md`
- `batch-cards/515-memory-proposal-record-types.md`
- `batch-cards/514-nucleus-memory-crate-front-door.md`
- `batch-cards/513-memory-proposal-boundary-selection.md`

## Acceptance Criteria

- [x] Memory proposal records are owned by a focused crate.
- [x] Proposed memories remain evidence until explicitly accepted.
- [x] User-private and restricted memory boundaries are represented.
- [x] Secret values, raw transcripts, provider payloads, and raw terminal
  streams are excluded.
- [x] Planning, research, task, and artifact links are refs only.
- [x] No embedding, semantic search, autonomous extraction, provider-native
  sync, active task creation, projection apply, UI behavior, or provider/SCM
  effect is added.

## Stop Conditions

- The work requires choosing a vector database or embedding model.
- The work requires autonomous memory extraction policy.
- The work requires final memory review UI.
- The work requires storing raw transcripts, provider payloads, credentials, or
  raw terminal streams.
- The work requires accepting memories into authoritative project context.
- The work requires projecting memories to repo files or applying repo-file
  imports.

## Boundary Decision

Memory proposal foundation is the next useful lane because it gives planning
and future research output somewhere durable to land without forcing
acceptance, embeddings, search, or UI.

Selected first implementation boundary:

- crate: `nucleus-memory`
- authority: memory proposals only
- proposal records are reviewable evidence
- accepted memory mutation, project-context mutation, projection, embeddings,
  autonomous extraction, and provider-native memory sync are deferred

Initial crate-owned records:

- memory proposal ids
- scopes
- kinds
- statuses
- source refs
- confidence
- sensitivity
- retention posture
- review state
- supersession refs
- promotion target refs

Initial source refs:

- planning sessions
- exploration sessions
- planning artifacts
- task seeds
- research brief refs
- tasks
- agent sessions
- sanitized evidence refs
- provider-neutral SCM change refs
- documents
- custom refs

Deferred surfaces:

- accepted memory mutation commands
- memory embeddings
- semantic search and ranking
- autonomous extraction
- provider-native memory sync
- memory projection files
- final memory review UI
- secret or raw payload storage
- raw transcript storage
- provider payload storage
- raw terminal stream storage
- credential or secret value storage
- private-note storage by default

Rationale:

- planning sessions can already point at memory proposal refs, but no memory
  proposal record exists
- deep research should be able to produce memory proposals later
- memory proposal records are a smaller and safer step than deep research
  execution or planning UI
- keeping proposal records separate from accepted memory avoids silently
  mutating project context before review policy exists

## Closeout

Completed memory proposal foundation:

- `nucleus-memory` crate front door, proposal records, review/sensitivity/
  retention records, linkage refs, and JSON storage codec
- shared-memory SQLite repository support for stored memory proposal records
- read-only server projection/query/control DTO/`nucleusd`/Effigy inspection
- focused tests proving no accepted-memory mutation, projection authority,
  provider execution, task creation, UI behavior, embeddings, raw transcript
  storage, provider payload storage, terminal stream storage, credential
  storage, or private-note storage by default

Selected next lane: `120-deep-research-run-brief-foundation.md`.
