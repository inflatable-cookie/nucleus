# 130 Accepted Memory Projection File Materialization

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Materialize accepted shared memory into project management files only after the
projection policy gate has proven eligibility, deterministic refs, and
read-only diagnostics.

The selected next lane is projection file materialization, not review UI,
embeddings, semantic search, provider-native memory sync, automatic
extraction, task mutation, SCM/forge publication, or final product UI.

This lane may introduce scoped file writes under `nucleus/memory/` only after
an explicit admission model and payload codec exist. SCM/forge effects remain
out of scope.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/129-accepted-memory-projection-policy-gate.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Goals

- [x] Add an admitted write-intent model for accepted-memory projection files.
- [x] Define the projected memory file payload and stable TOML codec.
- [x] Materialize eligible accepted memories only under
  `nucleus/memory/<memory-id>.toml`.
- [x] Report materialized, skipped, blocked, invalid-ref, encode-failed, and
  no-effect counts through read-only diagnostics.
- [x] Expose diagnostics through server query/control DTO, `nucleusd`, and
  Effigy.
- [x] Keep SCM/forge mutation, import/apply, embeddings, semantic search,
  provider-native sync, automatic extraction, task mutation, and final UI out
  of scope.

## Execution Plan

- [x] Batch 1: projection write admission and file-root guard.
- [x] Batch 2: projected memory payload and TOML codec.
- [x] Batch 3: scoped materialization and write diagnostics.
- [x] Batch 4: query/control DTO, `nucleusd`, and Effigy inspection.
- [x] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- None

Planned cards:

- None

Completed cards:

- `batch-cards/574-accepted-memory-projection-validation-next-lane.md`
- `batch-cards/573-accepted-memory-projection-write-diagnostics-control.md`
- `batch-cards/572-accepted-memory-projection-file-materialization.md`
- `batch-cards/571-accepted-memory-projection-payload-codec.md`
- `batch-cards/570-accepted-memory-projection-write-admission.md`

## Admission Payload Materialization Result

Accepted-memory projection materialization now has three focused server
modules:

- write admission for stopped projectable export entries with deterministic
  plan refs and safe `nucleus/memory/<memory-id>.toml` file refs
- a pure versioned TOML payload codec for sanitized accepted-memory projection
  records
- a scoped materializer that writes admitted payloads only below
  `nucleus/memory/` and reports skipped, blocked, unsafe-path, encode-failed,
  and write-failed outcomes

The implementation does not call SCM/forge providers, import/apply projected
files, run embeddings/search, sync provider-native memory, mutate tasks, or
add UI behavior.

## Diagnostics And Closeout Result

Accepted-memory projection materialization is now inspectable through server
query, control DTO, `nucleusd`, and Effigy. Diagnostics report admitted and
blocked writes, payload readiness, materialized file count, skipped records,
blockers, file refs, and explicit no-effect flags.

The next selected lane is accepted-memory projection import validation. That
lane should scan and validate `nucleus/memory/*.toml` files before any active
apply, SCM capture/share, embeddings/search, provider-native sync, automatic
extraction, task mutation, or final UI.

## Lane Decision

Roadmap `129` proved that accepted-memory projection can be classified and
inspected without raw bodies or effects. The next useful boundary is the
smallest committable project-context artifact: deterministic files under
`nucleus/memory/`.

Review controls are deferred because accepted memory already has review
evidence and this lane needs write admission before product controls. Search,
embeddings, provider-native sync, and UI are deferred because they depend on a
stable projected shared-memory substrate.

## Stop Conditions

- The work requires SCM/forge capture, publish, push, PR, merge, or provider
  network effects.
- The work requires importing projected memory files back into active server
  state.
- The work requires embeddings, vector search, semantic ranking, provider
  memory sync, or automatic memory extraction.
- The work requires final memory UI behavior or desktop controls.
- The work requires writing outside the admitted `nucleus/memory/` projection
  root.
- The work requires raw transcripts, provider payloads, terminal streams,
  private notes, credentials, or secret values.

## Acceptance Criteria

- [x] Projection writes are admitted explicitly before any file is written.
- [x] Projected memory TOML is deterministic, stable-id based, and sanitized.
- [x] File writes are scoped to `nucleus/memory/<memory-id>.toml`.
- [x] Diagnostics report materialization counts, blockers, file refs, and
  no-effect flags.
- [x] SCM/forge mutation, import/apply, embeddings/search/provider sync,
  automatic extraction, task mutation, and final UI remain out of scope.
