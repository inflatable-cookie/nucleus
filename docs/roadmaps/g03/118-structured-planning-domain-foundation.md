# 118 Structured Planning Domain Foundation

Status: completed
Owner: Tom
Updated: 2026-07-03

## Purpose

Start the app-native structured planning domain.

Recent lanes built task seed records, task seed promotion, planning projection
payloads, repo-file export, publication/share gates, and import/admission
diagnostics. Those surfaces are useful, but they are still downstream of a
missing domain: Nucleus needs first-class planning and exploration records
before active import apply, memory linkage, deep research integration, or UI
planning flows can become coherent.

This lane creates the Rust/domain foundation for planning sessions,
open-ended exploration state, question backlogs, option maps, accepted planning
artifacts, and task-seed linkage. It does not implement the final UI, run
models, schedule agents, create active tasks, apply projected files, or
introduce memory embeddings.

## Governing Refs

- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/026-open-ended-planning-conversation-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/roadmaps/g03/117-planning-projection-import-admission.md`

## Goals

- [x] Select the narrow structured planning domain boundary.
- [x] Add a focused `nucleus-planning` crate instead of expanding
  `nucleus-server` or `nucleus-engine` as a catch-all.
- [x] Model planning sessions and exploration sessions as durable value
  records.
- [x] Model question backlog, option map, and promotion refs without raw
  transcript authority.
- [x] Define how existing planning artifact and task-seed records relate to
  the new planning domain without duplicating task authority.
- [x] Add storage codec and read-only inspection only after the record boundary
  is stable.
- [x] Keep provider execution, agent scheduling, task creation, memory
  embeddings, deep research crawling, active import apply, and UI behavior out
  of scope.

## Execution Plan

- [x] Batch 1: select the structured planning domain boundary and deferred
  surfaces.
- [x] Batch 2: add the `nucleus-planning` crate front door and module
  skeleton.
- [x] Batch 3: add planning session and exploration session value records.
- [x] Batch 4: add question backlog, assumption, option, risk, and promotion
  ref value records.
- [x] Batch 5: define artifact/task-seed linkage and storage codec shape.
- [x] Batch 6: expose read-only server/query/CLI/Effigy inspection if the
  storage path is ready.
- [x] Batch 7: validate and choose whether the next lane is planning session
  persistence, planning-memory proposals, deep research run briefs, or import
  apply/review.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/512-structured-planning-validation-next-lane.md`
- `batch-cards/511-planning-session-query-cli-effigy.md`
- `batch-cards/510-planning-session-storage-codec.md`
- `batch-cards/509-planning-artifact-task-seed-linkage.md`
- `batch-cards/508-exploration-question-option-records.md`
- `batch-cards/507-planning-session-record-types.md`
- `batch-cards/506-nucleus-planning-crate-front-door.md`
- `batch-cards/505-structured-planning-domain-boundary-selection.md`

## Acceptance Criteria

- [x] Planning domain records are owned by a focused crate, not jammed into
  `lib.rs`, `nucleus-server`, or broad engine modules.
- [x] Open-ended exploration remains distinct from finite task planning.
- [x] Raw transcripts remain source material, not durable planning authority.
- [x] Task seeds remain provisional until promoted through the task domain.
- [x] Memory proposals and research run refs are represented as refs only.
- [x] No provider execution, agent scheduling, active task creation, active
  import apply, SCM/forge mutation, memory embedding, or UI behavior is added.

## Closeout

Structured planning now has:

- a focused `nucleus-planning` crate
- guided planning session records
- open-ended exploration session records
- question, assumption, option, note, and promotion-ref records
- artifact/task-seed linkage records
- JSON storage codecs
- read-only planning session query, DTO, `nucleusd`, and Effigy inspection

The next selected lane is
`119-planning-memory-proposal-foundation.md`.

## Stop Conditions

- The work requires deciding final planning UI design.
- The work requires autonomous model orchestration or planner personas.
- The work requires storing raw transcripts as planning authority.
- The work requires active task creation from planning output.
- The work requires memory extraction policy, embeddings, or deep research
  execution.
- The work requires applying projected repo files into active planning
  authority.

## Boundary Decision

The first structured planning slice belongs in a focused `nucleus-planning`
crate.

Initial crate-owned records:

- planning session ids, kinds, statuses, participants, source refs, output refs,
  and timestamps
- exploration session ids, scope prompts, statuses, source conversation refs,
  and promotion refs
- question backlog records
- assumption records
- option records with tradeoff fields
- risk, opportunity, and constraint notes
- promotion refs to accepted planning artifacts, task seeds, memory proposals,
  research run briefs, decision records, goals, and roadmap branches

Compatibility surfaces:

- existing planning artifact and task seed records stay in their current
  engine/server compatibility path until the new crate proves the record
  boundary
- task seed promotion remains a task-domain command
- management projection export/import remains a stopped review/sync surface,
  not the active planning database

Deferred surfaces:

- raw transcript retention as planning authority
- prompt/template/plugin execution
- model orchestration, planner personas, and autonomous loops
- active task creation from planning output
- active import apply from repo projection files
- shared memory extraction policy, embeddings, and memory review UI
- deep research execution, crawling, browser automation, and citation UI
- final planning UI

Rationale:

- the original product goal needs guided planning and open-ended exploration
  as first-class domain state
- active projection apply is premature until there is app-native planning state
  to apply into
- memory and deep research should attach to planning records through refs
  before they become standalone implementation lanes
