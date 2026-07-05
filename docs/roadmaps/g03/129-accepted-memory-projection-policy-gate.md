# 129 Accepted Memory Projection Policy Gate

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Define the accepted-memory projection policy before Nucleus writes shared
memory records into a project management repository.

Accepted memory is now server-owned, persisted, and inspectable. The next
boundary is deciding which accepted records are eligible to become shared
project context and which must remain server-local. This lane must stay
stopped and diagnostic-first until policy, blockers, deterministic refs, and
operator review expectations are explicit.

This lane must not write `nucleus/memory/*.toml`, run embeddings, perform
semantic search, sync provider-native memory, extract memories automatically,
mutate tasks, call SCM/forge providers, or add final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g03/128-accepted-memory-read-only-inspection.md`

## Goals

- [x] Add a server-owned projection eligibility model for accepted memory.
- [x] Classify accepted records into projectable, local-only, blocked, and
  review-required buckets.
- [x] Produce deterministic stopped export-plan refs for eligible records
  without writing files.
- [x] Expose read-only diagnostics through server query.
- [x] Expose read-only diagnostics through control DTO,
  `nucleusd`, and Effigy.
- [x] Keep real projection writes, import/apply, SCM/forge mutation,
  embeddings, search, provider sync, automatic extraction, task mutation, and
  final UI out of scope.

## Execution Plan

- [x] Batch 1: projection policy and eligibility model.
- [x] Batch 2: stopped export-plan refs and path policy.
- [x] Batch 3: server query and diagnostics projection.
- [x] Batch 4: serialized DTO, `nucleusd`, and Effigy inspection.
- [x] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- None

Planned cards:

- None

Completed cards:

- `batch-cards/569-accepted-memory-projection-validation-next-lane.md`
- `batch-cards/568-accepted-memory-projection-dto-cli-effigy.md`
- `batch-cards/567-accepted-memory-projection-diagnostics-query.md`
- `batch-cards/566-accepted-memory-stopped-export-plan.md`
- `batch-cards/565-accepted-memory-projection-policy-model.md`

## Policy Result

Accepted-memory projection policy now classifies accepted-memory storage
records as projectable, local-only, review-required, or blocked before any
projection path is materialized.

The policy remains server-local and no-effect. It blocks or defers records for
sensitivity, retention, lifecycle status, supersession, missing review
evidence, missing project scope, out-of-scope project refs, and unsafe memory
ids.

## Export Plan Result

Accepted-memory projection now has stopped export-plan records. Projectable
accepted memories produce deterministic plan refs and file refs under
`nucleus/memory/<memory-id>.toml`.

Blocked records preserve sanitized policy and export blockers for policy
denial, unsupported schema, unsupported memory kind, and unsafe path refs. The
plan records explicitly report that no projection file write or SCM effect has
run.

## Query Result

Accepted-memory projection readiness now has a read-only server query result.
It reads shared-memory state, decodes accepted-memory records, skips proposal
and decode-failed records, suppresses out-of-scope accepted ids, and reports
projectable, local-only, blocked, review-required, and skipped counts.

The server query keeps DTO/CLI/Effigy exposure, projection file writes,
import/apply, SCM/forge effects, embeddings, search, provider sync, task
mutation, and UI behavior out of scope.

## DTO CLI Effigy Result

Accepted-memory projection readiness now crosses the transport and operator
inspection boundary. The control envelope has request/response DTOs for the
diagnostics query, `nucleusd` exposes `query accepted-memory-projection
--project <project-id>`, and Effigy exposes
`server:query:accepted-memory-projection`.

The rendered output includes counts, plan refs, path refs, blocker reasons,
and no-effect flags. It does not expose raw memory bodies, provider payloads,
terminal streams, projection writes, SCM effects, import/apply effects,
embeddings, semantic search, provider sync, task mutation, or UI behavior.

## Validation And Next Lane Result

Validation passed for focused accepted-memory projection tests, server
control-envelope tests, `nucleusd` rendering tests, relevant cargo checks,
docs QA, Northstar QA, diff check, and doctor. Doctor remains warning-only for
existing god-file findings.

The next lane is `130-accepted-memory-projection-file-materialization.md`.
That lane may add scoped projection file writes only after explicit write
admission and a deterministic sanitized payload codec. SCM/forge mutation,
import/apply, embeddings, semantic search, provider-native sync, automatic
extraction, task mutation, and final UI remain out of scope.

## Lane Decision

Accepted-memory read inspection proved that Nucleus can list server-owned
accepted memories without exposing raw memory bodies. The next useful step is
projection policy, not search or UI.

Projection policy is the right boundary because the shared-memory contract
already names `nucleus/memory/<memory-id>.toml` as the first-pass projection
root, but the server still lacks an explicit gate for sensitivity, retention,
review state, supersession, path safety, and export intent.

## Stop Conditions

- The lane requires writing projection files.
- The lane requires applying imported memory records.
- The lane requires SCM/forge capture, publish, push, PR, or merge effects.
- The lane requires embeddings, vector search, semantic ranking, provider
  memory sync, automatic extraction, or raw transcript retention.
- The lane requires final memory UI behavior instead of read-only diagnostics.
- The lane requires storing credentials, secret values, raw provider payloads,
  raw terminal streams, private notes, or raw conversation transcripts.

## Acceptance Criteria

- [x] Projection eligibility is explicit and testable.
- [x] Sensitive, local-only, restricted, stale, superseded, and unreviewed
  records are blocked or review-required before projection.
- [x] Export-plan refs are deterministic and path-safe without writing files.
- [x] Diagnostics expose counts, blocker reasons, refs, and no-effect flags.
- [x] The next lane is selected from validation evidence.
