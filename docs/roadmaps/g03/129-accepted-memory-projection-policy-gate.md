# 129 Accepted Memory Projection Policy Gate

Status: ready
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

- [ ] Add a server-owned projection eligibility model for accepted memory.
- [ ] Classify accepted records into projectable, local-only, blocked, and
  review-required buckets.
- [ ] Produce deterministic stopped export-plan refs for eligible records
  without writing files.
- [ ] Expose read-only diagnostics through server query, control DTO,
  `nucleusd`, and Effigy.
- [ ] Keep real projection writes, import/apply, SCM/forge mutation,
  embeddings, search, provider sync, automatic extraction, task mutation, and
  final UI out of scope.

## Execution Plan

- [ ] Batch 1: projection policy and eligibility model.
- [ ] Batch 2: stopped export-plan refs and path policy.
- [ ] Batch 3: server query and diagnostics projection.
- [ ] Batch 4: serialized DTO, `nucleusd`, and Effigy inspection.
- [ ] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- `batch-cards/565-accepted-memory-projection-policy-model.md`

Planned cards:

- `batch-cards/566-accepted-memory-stopped-export-plan.md`
- `batch-cards/567-accepted-memory-projection-diagnostics-query.md`
- `batch-cards/568-accepted-memory-projection-dto-cli-effigy.md`
- `batch-cards/569-accepted-memory-projection-validation-next-lane.md`

Completed cards:

- None.

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

- [ ] Projection eligibility is explicit and testable.
- [ ] Sensitive, local-only, restricted, stale, superseded, and unreviewed
  records are blocked or review-required before projection.
- [ ] Export-plan refs are deterministic and path-safe without writing files.
- [ ] Diagnostics expose counts, blocker reasons, refs, and no-effect flags.
- [ ] The next lane is selected from validation evidence.
