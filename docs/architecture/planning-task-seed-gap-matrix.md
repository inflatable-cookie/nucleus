# Planning Task Seed Gap Matrix

Status: draft
Owner: Tom
Updated: 2026-06-23

## Purpose

Map current planning and task seed implementation to the promoted contracts,
then choose the first bounded implementation slice.

This matrix does not authorize active task creation, provider execution,
SCM/forge mutation, scoring policy, autonomous goal loops, or UI work.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/contracts/026-open-ended-planning-conversation-contract.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`

## Current Surfaces

### Bootstrap Task Seed Helper

Code:

- `crates/nucleus-server/src/task_seed.rs`

Current behavior:

- writes a concrete task record into the Tasks domain
- seeds `task:nucleus-local:bootstrap`
- is idempotent
- is queryable as a normal task

Classification:

- bootstrap helper only
- not a structured planning task seed model
- not suitable as the first planning artifact/task seed authority

Risk:

- the name `task_seed` can imply planning task seeds, but it currently creates
  active task records. The planning lane must not reuse that behavior for
  reviewable task seeds.

### Task Commands

Code:

- `crates/nucleus-engine/src/task_commands/model.rs`
- `crates/nucleus-engine/src/task_commands/service.rs`
- `crates/nucleus-server/src/request_handler/task_commands.rs`

Current behavior:

- create/update/delegate/start/block/complete/archive task commands exist
- create command produces active task records through task-domain authority
- delegation creates scheduled work-item records without provider execution

Classification:

- useful later for promotion commands
- out of scope for the first read-only planning task seed slice

### Task Projection

Code:

- `crates/nucleus-tasks/src/projection.rs`
- `crates/nucleus-engine/src/management_projection/types.rs`

Current behavior:

- task projection records exist
- management projection has `PlanningArtifact` as a record kind
- management projection payload does not yet include planning artifact or task
  seed records

Classification:

- enough vocabulary for later repo projection
- not enough implementation for planning/task seed storage or export

### Planning Storage Vocabulary

Code:

- `crates/nucleus-core/src/persistence.rs`
- `crates/nucleus-local-store/src/repositories.rs`
- `crates/nucleus-local-store/src/domains.rs`
- `crates/nucleus-local-store/src/fixtures.rs`

Current behavior:

- persistence domain `Planning` exists
- persistence record kinds include `PlanningSession`, `PlanningArtifact`, and
  `TaskSeed`
- local-store repository descriptor names planning sessions, artifacts, and
  task seed records

Classification:

- storage vocabulary exists
- no domain record model or server query exists yet

## Missing Surfaces

- planning session records
- planning artifact records
- task seed records
- task seed review state
- task seed promotion readiness
- read-only planning/task seed query
- planning artifact/task seed management projection payload
- promotion command from reviewed task seed to task-domain create command

## Selected First Slice

Implement portable engine record and projection types for planning artifacts
and task seed candidates.

The first slice should include:

- planning artifact ids and record metadata
- planning artifact kinds and statuses
- task seed ids and candidate records
- task seed review state
- promotion readiness classification
- deterministic task seed candidate projection
- explicit no-effect flags

The first slice should not include:

- local-store persistence
- server query/DTO/CLI/Effigy
- task creation
- promotion command
- repo projection
- UI

## Implementation Progress

Implemented in `nucleus-engine`:

- planning artifact ids, record metadata, kinds, statuses, and review state
- task seed ids, candidate records, review state, and promotion state
- deterministic task seed candidate projection
- explicit no-effect flags for client promotion and task creation
- conservative readiness classification where explicit blockers win

Implemented in `nucleus-server` and `nucleusd`:

- `PlanningTaskSeedsQuery` and `ServerQueryResult::PlanningTaskSeeds`
- serialized control request/response DTOs for candidate inspection
- unsupported promotion/action rejection at the envelope boundary
- `nucleusd query planning-task-seeds --project <project-id>`
- `effigy server:query:planning-task-seeds`
- server query composition from persisted Planning/TaskSeed records
- bootstrap fixture path for one reviewable planning task seed
- server-side `TaskCommand::PromoteSeed` composition from planning seed
  storage into task-domain create plus planning seed promotion-state update
- serialized command DTO coverage for task seed promotion
- read-only promotion diagnostics over persisted planning seeds and promoted
  task refs
- `nucleusd query task-seed-promotion-diagnostics --project <project-id>`
- `effigy server:query:task-seed-promotion-diagnostics`

Implemented in storage:

- task seed JSON storage codec owned by `nucleus-engine`
- reversible task seed storage conversion to/from
  `EngineTaskSeedCandidateRecord`
- SQLite Planning domain table
- SQLite record-kind support for planning session, planning artifact, and task
  seed records

Defined for projection:

- planning artifact management projection file shape
- planning task seed management projection file shape
- merge and review gaps before projection import/export

Still deferred:

- management repo projection payload implementation

## Ownership Boundary

First implementation: `nucleus-engine`.

Reason:

- planning/task seed records are portable product workflow state
- server should compose/query them later, not own the domain model
- `nucleus-tasks` owns active task records, while planning task seeds are not
  active tasks
- a dedicated planning crate may be useful later, but a focused engine module
  is the smallest non-speculative step now

Storage selection:

- `docs/architecture/planning-task-seed-storage-codec-selection.md`

Projection shape:

- `docs/architecture/planning-management-projection-shape.md`

Promotion admission:

- `docs/architecture/task-seed-promotion-admission.md`

## Promotion Rule

Task seed promotion is now selected as an explicit task-domain command path.

Only accepted seeds marked `ReadyForPromotion` with no blocking questions may
create a task. Draft, review-requested, rejected, superseded, blocked,
not-ready, reviewable, and already-promoted seeds must not create new task
records.

Promotion must create through task-domain storage, update the planning seed
state to `Promoted`, and preserve idempotency evidence. Task seeds must not
silently become active tasks, and the bootstrap `seed_local_task` helper must
not be used as the promotion path.

## Planning Gaps

- management projection payload implementation for planning records
- whether planning sessions and task seed groups should live in one module or
  a future `nucleus-planning` crate
- multi-user merge/review policy for planning artifacts and task seeds
