# 553 Minimum Planning Import Apply Proof Scope

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../126-minimum-planning-import-apply-proof.md`

## Purpose

Choose the smallest safe apply proof and its stop conditions.

## Work

- [x] Select one planning artifact target shape for proof.
- [x] Define required admission/executor evidence refs.
- [x] Define what mutation is allowed and what remains blocked.
- [x] Decide whether implementation should proceed or the import/apply lane
  should pause entirely.

## Acceptance Criteria

- [x] Scope is narrow enough to implement without another infrastructure layer.
- [x] Task creation, provider execution, SCM/forge mutation, accepted memory
  mutation, semantic merge automation, and UI behavior remain out of scope.
- [x] The next implementation card has clear stop/go criteria.

## Decision

Proceed with one minimum proof only:

- target one existing active planning artifact record
- apply one reviewed planning projection import file to that record
- require exact revision match before mutation
- emit one sanitized mutation receipt with old revision, new revision,
  admission ref, executor-plan ref, operator approval ref, import file ref, and
  applied operation ref
- reject create, delete, rename, multi-record apply, semantic merge, and task
  seed promotion

The proof may reuse the existing active-apply admission and stopped executor
plan model. It should not add another generic import/apply infrastructure
layer.

## Required Evidence Refs

- active-apply admission ref
- stopped executor-plan ref
- operator approval ref
- import file ref
- target planning artifact ref
- expected current revision ref
- observed current revision ref
- applied operation ref
- sanitization policy ref
- mutation receipt ref

## Allowed Mutation

The only allowed mutation is an exact-revision replacement of one existing
planning artifact payload with reviewed imported planning content.

The mutation must fail closed when the current artifact revision differs from
the expected revision, the target artifact is missing, the import record is not
reviewed, or the admission/executor refs are absent.

## Blocked Work

The proof must not create tasks, promote task seeds, call providers, mutate SCM
or forge state, write accepted memory, run semantic merge automation, retain raw
projected payloads beyond the immediate operation, or add UI behavior.

## Stop/Go Criteria

Card `554` may proceed only if the implementation can stay inside this
single-record exact-revision path.

Stop instead if implementation requires a generic merge engine, new authority
for multiple record families, raw payload retention, provider execution,
SCM/forge mutation, accepted memory mutation, task promotion, or UI workflow
state.
