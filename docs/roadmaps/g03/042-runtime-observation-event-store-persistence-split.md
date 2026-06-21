# 042 Runtime Observation Event Store Persistence Split

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/codex_supervision/runtime_observation_event_store_persistence.rs`,
into focused support modules without changing runtime observation event-store
persistence behavior or granting provider/task authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/009-harness-runtime-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [ ] Move runtime observation event-store persistence types/support code out
  of the front door where it reduces real pressure.
- [ ] Move codec/helper/test code into focused modules if needed.
- [ ] Preserve persistence behavior and public type names.
- [ ] Avoid provider write, callback response, process spawn, SCM mutation,
  remote transport, UI, and task mutation behavior changes.

## Execution Plan

- [ ] Type/support split batch.
- [ ] Codec/helper/test split batch.
- [ ] Validation and closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/139-runtime-observation-event-store-persistence-type-split.md`

Planned cards:

- `batch-cards/140-runtime-observation-event-store-persistence-helper-test-split.md`
- `batch-cards/141-runtime-observation-event-store-persistence-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] The runtime observation event-store persistence front door drops below
  the doctor error threshold.
- [ ] Existing focused tests pass.
- [ ] `cargo check -p nucleus-server` passes.
- [ ] Doctor status is refreshed or remaining blockers are recorded.
- [ ] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.
