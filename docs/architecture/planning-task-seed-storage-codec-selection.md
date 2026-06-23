# Planning Task Seed Storage Codec Selection

Status: active
Owner: Tom
Updated: 2026-06-23

## Purpose

Record the first durable storage decision for planning task seed candidates.

This note does not authorize task promotion, active task creation, provider
execution, SCM/forge mutation, repo projection writes, scoring policy, goal
loops, or UI-triggered mutation.

## Existing Pattern

Current durable model codecs are model-owned JSON projections:

- `nucleus-projects` owns project storage records and codecs.
- `nucleus-tasks` owns task storage records, task encode/decode, and
  task-from-storage reconstruction.
- `nucleus-command-policy` owns command request/evidence storage records and
  codecs.
- `nucleus-local-store` owns generic record envelopes, repositories, SQLite
  tables, and record-kind/domain routing. It does not own domain object
  schemas.

## Decision

Planning task seed storage is owned by `nucleus-engine` for now.

Reason:

- planning task seed records currently live in `nucleus-engine`
- the server should compose, persist, and query records, not own the planning
  domain schema
- `nucleus-tasks` owns active tasks, so storing reviewable task seeds there
  would blur the promotion boundary
- a future `nucleus-planning` crate may become appropriate when planning
  sessions, artifacts, projection policy, and merge policy grow beyond a
  focused engine module

## First Codec Target

First implementation target:

- `PlanningTaskSeedStorageRecord`
- JSON encode/decode helpers
- reversible conversion to/from `EngineTaskSeedCandidateRecord`
- sanitized refs only: project id, seed id, source artifact id, context refs,
  validation hint refs, blocker text, review state, promotion state

Deferred:

- planning artifact storage codec
- planning session storage codec
- repo-backed projection files
- merge policy for shared planning records
- task seed promotion command

## Local Store Routing

Planning records use:

- domain: `PersistenceDomain::Planning`
- task seed kind: `PersistenceRecordKind::TaskSeed`
- planning artifact kind: `PersistenceRecordKind::PlanningArtifact`
- planning session kind: `PersistenceRecordKind::PlanningSession`

SQLite local storage must support the Planning domain as a generic record
table before query-from-persistence can be useful.

## Promotion Boundary

Task seed promotion remains a later task-domain command.

Persisting a task seed records planning output only. It must not create a
`PersistenceRecordKind::Task`, mutate active task state, assign an agent, start
provider execution, or change task readiness.
