# 505 Structured Planning Domain Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Select the first bounded structured planning domain slice.

## Work

- [x] Audit contracts `014`, `026`, `013`, `015`, and `025` for the first
  planning-domain record boundary.
- [x] Decide which records belong in `nucleus-planning` first.
- [x] Decide which existing planning artifact/task seed records stay in
  engine/server compatibility surfaces for now.
- [x] Name deferred surfaces and blocked effects.

## Acceptance Criteria

- [x] The first implementation batch is narrow enough to execute without UI,
  model orchestration, memory embeddings, deep research execution, task
  creation, or import apply.
- [x] The decision explains why this lane is more valuable now than continuing
  projection import/apply mechanics.
- [x] The next implementation card has a clear crate/module boundary.

## Decision

Create a focused `nucleus-planning` crate before adding storage/query behavior.

First crate-owned records:

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

Keep for compatibility:

- existing planning artifact and task seed records in the current
  engine/server path
- task seed promotion in the task-domain command path
- management projection export/import as stopped review/sync surfaces

Blocked in this lane:

- raw transcripts as planning authority
- final UI design
- model orchestration or planner personas
- autonomous loops
- active task creation
- active import apply
- memory extraction policy or embeddings
- deep research execution
- provider, SCM, or forge effects

Reason:

The project now has enough projection mechanics. Continuing into import/apply
would overbuild sync plumbing before the product has app-native planning state.
Structured planning and open-ended exploration are closer to the original
Nucleus goal and provide the anchor that memory, research, tasks, and
projection apply can later attach to.
