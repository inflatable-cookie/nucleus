# Planning Management Projection Shape

Status: draft
Owner: Tom
Updated: 2026-07-02

## Purpose

Define the intended repo-backed projection shape for planning artifacts and task
seeds before implementation.

This document does not authorize filesystem writes, SCM/forge mutation,
projection import, task promotion, task mutation, provider execution, or UI
behavior.

## Existing Projection Baseline

The current management projection system already has:

- root: `nucleus/`
- schema: `nucleus.management_projection.v1`
- project projection files
- task projection files
- deterministic TOML document encode/decode
- `ManagementProjectionRecordKind::PlanningArtifact`
- no concrete planning artifact payload
- no concrete planning task seed record kind

## Planning Artifact File Shape

First shared planning artifact file path:

```text
nucleus/planning/<artifact-id>.toml
```

Envelope:

- schema version
- record id: artifact id
- record kind: `planning_artifact`
- file ref: `nucleus/planning/<artifact-id>.toml`

Payload fields:

- artifact id
- project id
- artifact kind
- title
- body as text or structured ref
- status
- source planning session ref
- source research run refs
- source memory refs
- supersedes refs
- superseded-by refs
- projection ref
- review state

Projected artifacts must not include private brainstorming, raw transcripts,
credential material, raw provider payloads, raw browser caches, restricted
memory contents, or unreviewed model output by default.

## Task Seed File Shape

Task seeds should be separate shared planning records, not active task records.

Proposed first file path:

```text
nucleus/planning/task-seeds/<seed-id>.toml
```

Envelope:

- schema version
- record id: task seed id
- record kind: `planning_task_seed`
- file ref: `nucleus/planning/task-seeds/<seed-id>.toml`

Payload fields:

- seed id
- project id
- source artifact id
- title
- problem statement
- suggested action type
- suggested importance
- acceptance criteria draft
- context refs
- blocking questions
- agent-readiness hints
- review state
- promotion state as data only

The first implementation may need to add
`ManagementProjectionRecordKind::PlanningTaskSeed`. Until that exists, task seed
projection must not be smuggled through `Task` or silently encoded as an active
task.

## Promotion Boundary

Projected task seeds are not active tasks.

Importing or reading a task seed projection file must not:

- create `PersistenceRecordKind::Task`
- change task assignment
- schedule agent work
- start provider execution
- mark a task complete
- mutate SCM/forge state

Promotion must remain a later task-domain command.

## Import Admission Boundary

Planning projection import has four distinct stages:

- scan: inspect projected files under supported management paths and classify
  them as candidates
- admission: accept reviewed candidates into stopped import records
- conflict staging: record semantic conflicts that must be reviewed before
  apply
- apply: mutate active planning/task authority, intentionally deferred

Projected files are shared management artifacts, not active server authority.
Import must therefore read files into controlled server records before any
planning state changes. A clean scan or admission record only proves that a
file is shaped well enough for review; it does not make the file authoritative.

First supported paths:

- `nucleus/planning/<artifact-id>.toml`
- `nucleus/planning/task-seeds/<seed-id>.toml`

First candidate states:

- ready
- blocked unsupported schema
- blocked unsupported record kind
- blocked unsafe path
- blocked parse failure
- blocked duplicate projection id
- blocked missing source refs
- blocked semantic conflict

First admission states:

- admitted stopped import
- duplicate no-op
- blocked

No-effect flags must remain explicit for:

- active planning mutation
- task creation
- task seed promotion
- agent scheduling
- provider execution
- SCM mutation
- forge mutation
- callback, interruption, and recovery execution
- raw payload retention
- UI-triggered apply

Semantic conflicts are staged, not resolved. The first conflict set should
cover artifact title/body conflicts, review-state conflicts, lineage conflicts,
duplicate task seed ids, task seed promotion-state conflicts, and missing
source refs.

## Merge And Review Gaps

Open gaps before implementation:

- concurrent edits to artifact body or title
- artifact status conflicts, especially accepted versus superseded
- review state conflicts across users
- supersedes/superseded-by lineage conflicts
- duplicate task seed ids from separate planning sessions
- task seed promotion state conflicts
- source artifact ref repair when an artifact is renamed or removed
- import behavior for accepted planning output that conflicts with local
  server authority

First implementation should stage conflicts for review. It should not auto-merge
semantic conflicts or apply shared files as active planning authority without a
review/admission step.

## Implemented Work

- concrete management projection payload types
- file ref constructors for planning artifacts and task seeds
- TOML encode/decode tests for planning projection records
- management projection export from Planning domain records
- read-only planning projection export diagnostics
- deterministic planning projection file materialization under
  `nucleus/planning/` and `nucleus/planning/task-seeds/`
- planning projection file-write diagnostics
- management-capture preparation from sanitized planning projection file-write
  evidence
- planning projection capture publication/share admission and stopped request
  diagnostics
- selected planning projection import/admission boundary and blocked authority
  model
- read-only planning projection import scan candidates for planning artifacts
  and task seeds
- stopped planning projection import admission records from reviewed scan
  candidates
- planning projection import semantic conflict staging records for artifact,
  task seed, and missing-ref conflicts
- read-only planning projection import diagnostics over candidates,
  admissions, conflicts, blockers, evidence refs, and no-effect flags
- server query, control DTO, CLI, and Effigy inspection for planning projection
  import diagnostics

## Deferred Work

- active apply of admitted planning records
- multi-user merge policy
- promotion from reviewed task seed to active task
