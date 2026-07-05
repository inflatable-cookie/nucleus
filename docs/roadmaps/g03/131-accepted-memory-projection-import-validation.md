# 131 Accepted Memory Projection Import Validation

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Validate projected accepted-memory files before Nucleus imports them into
active server state.

Roadmap `130` proved scoped materialization of sanitized
`nucleus/memory/<memory-id>.toml` files. The next boundary is read-only import
validation: scan projected memory files, decode payloads, classify candidates,
and stage conflicts without applying imported memory.

This lane must not mutate active accepted memory, call SCM/forge providers,
run embeddings/search, sync provider-native memory, extract memories
automatically, mutate tasks, or add final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/130-accepted-memory-projection-file-materialization.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Goals

- [x] Scan projected `nucleus/memory/*.toml` files as read-only import
  candidates.
- [x] Validate schema, memory id, path safety, project scope, sensitivity,
  retention, review evidence, and unsupported future schema.
- [x] Stage semantic conflicts without resolving or applying them.
- [x] Expose read-only import validation diagnostics through server query,
  control DTO, `nucleusd`, and Effigy.
- [x] Keep active memory apply, SCM/forge mutation, embeddings/search/provider
  sync, automatic extraction, task mutation, and final UI out of scope.

## Execution Plan

- [x] Batch 1: projected memory scan candidates and validation classes.
- [x] Batch 2: stopped import admission and conflict staging.
- [x] Batch 3: diagnostics/control/CLI/Effigy inspection.
- [x] Batch 4: validation and next-lane selection.

## Batch Cards

Ready cards:

None.

Planned cards:

- None

Completed cards:

- `batch-cards/578-accepted-memory-import-validation-next-lane.md`
- `batch-cards/577-accepted-memory-import-diagnostics-control.md`
- `batch-cards/575-accepted-memory-import-candidates-and-admission.md`
- `batch-cards/576-accepted-memory-import-conflict-staging.md`

## Lane Decision

Import validation comes before SCM capture/share because projected memory files
need a consumer-side validation story before they are treated as portable
project state. It also comes before review controls, search, provider sync,
and UI because those surfaces depend on trustworthy projected memory records.

The next selected lane is stopped accepted-memory import apply/admission. It
will model operator-reviewed apply authority over validated projected memory
imports, but it will not mutate active accepted memory yet.

## Stop Conditions

- The work requires applying projected memory into active server state.
- The work requires SCM/forge capture, publish, push, PR, merge, or provider
  network effects.
- The work requires embeddings, vector search, semantic ranking,
  provider-native memory sync, or automatic extraction.
- The work requires final memory UI behavior or desktop controls.
- The work requires raw transcripts, provider payloads, terminal streams,
  private notes, credentials, or secret values.

## Acceptance Criteria

- [x] Projected memory files can be scanned and classified without effects.
- [x] Invalid, unsupported, unsafe, private, restricted, and conflicting
  records are blocked or staged for review.
- [x] Diagnostics expose candidates, blockers, conflicts, file refs, and
  no-effect flags.
- [x] Active memory apply, SCM/forge mutation, embeddings/search/provider sync,
  automatic extraction, task mutation, and final UI remain out of scope.
