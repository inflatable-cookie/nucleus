# 132 Accepted Memory Import Apply Admission

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Add a stopped apply/admission boundary for accepted-memory projection imports.

Roadmap `131` proved that projected `nucleus/memory/*.toml` files can be
scanned, validated, classified, deduplicated, and staged for conflict review
without importing them into active memory. This lane decides which validated
imports may receive operator-reviewed apply authority later.

This roadmap does not mutate active accepted memory. It creates policy,
admission records, and diagnostics only. Actual accepted-memory apply,
embeddings/search, provider-native memory sync, automatic extraction,
SCM/forge mutation, task mutation, and final UI behavior remain separate
authority lanes.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/131-accepted-memory-projection-import-validation.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Goals

- [x] Define stopped import-apply policy for validated projected memory
  imports.
- [x] Require explicit operator approval refs before apply authority can be
  admitted.
- [x] Preserve candidate refs, file refs, conflict refs, duplicate no-op state,
  provenance refs, and sanitized evidence refs.
- [x] Block unsafe, private, restricted, conflicting, unsupported, stale, raw,
  or effect-widened imports.
- [x] Expose read-only apply/admission diagnostics through server query,
  control DTO, `nucleusd`, and Effigy.
- [x] Keep active accepted-memory mutation, projection writes, SCM/forge
  mutation, embeddings/search/provider sync, automatic extraction, task
  mutation, and final UI behavior out of scope.

## Execution Plan

- [x] Batch 1: define stopped import-apply policy, authority, blockers,
  required refs, and deferred effects.
- [x] Batch 2: model apply/admission request, record, status, blocker,
  duplicate no-op, and no-effect types.
- [x] Batch 3: expose read-only apply/admission diagnostics through server
  query/control, `nucleusd`, and Effigy.
- [x] Batch 4: validate the lane and choose whether to build the active memory
  apply executor, SCM capture/share, review controls, search planning, product
  consumption, or a planning rebaseline.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/582-accepted-memory-import-apply-validation-next-lane.md`
- `batch-cards/581-accepted-memory-import-apply-diagnostics-control.md`
- `batch-cards/580-accepted-memory-import-apply-admission-records.md`
- `batch-cards/579-accepted-memory-import-apply-policy.md`

## Boundary Decision

Stopped import apply/admission is an authority record over validated projected
memory imports. It does not create or update accepted-memory records. It
decides whether a later executor may be built for an import record.

Eligible inputs:

- a validated import candidate from roadmap `131`
- candidate status ready for review or admission
- matching project id and memory id
- safe `nucleus/memory/<memory-id>.toml` file ref
- explicit operator approval ref for this admission step
- sanitized provenance and evidence refs
- no blocked validation status
- no unresolved semantic conflict
- no duplicate no-op requiring suppression
- no private/restricted visibility violation
- no unsupported schema or memory kind
- no raw transcript, provider payload, source body, credential, terminal
  stream, or secret material
- no requested active memory mutation, projection write, SCM/forge mutation,
  embedding/search, provider-native sync, automatic extraction, task mutation,
  agent scheduling, callback, interruption, recovery, or UI apply effect

Required refs:

- admission request id
- import candidate id
- memory id
- project id
- file ref
- operator ref
- approval ref
- sanitized evidence refs
- conflict review or resolution refs when a conflict was reviewed

Blocked cases:

- missing candidate, memory id, project id, file ref, operator ref, approval
  ref, or evidence ref
- validation-blocked candidate
- unresolved conflict
- duplicate no-op not explicitly accepted as no-op
- unsupported schema version, unsupported memory kind, or unsafe path
- private/restricted memory crossing visibility or projection policy
- raw payload/body, transcript, provider payload, source body, terminal stream,
  credential, or secret material present
- request attempts active accepted-memory mutation, projection file write,
  SCM/forge mutation, embeddings/search, provider-native sync, automatic
  extraction, task mutation, agent scheduling, callback, interruption,
  recovery, or UI behavior

Deferred effects:

- accepted-memory record creation/update/delete
- projection file writes
- SCM/forge capture, publication, push, PR, merge, or status effects
- embeddings, vector index writes, semantic search, or provider-native memory
  sync
- automatic memory extraction
- task mutation or task-link promotion
- agent scheduling, callback, interruption, recovery, or UI apply behavior

## Acceptance Criteria

- [x] Apply/admission records are distinct from import validation records and
  from any future active apply receipts.
- [x] Admission requires explicit operator approval refs.
- [x] Admission preserves sanitized provenance, file, candidate, conflict, and
  evidence refs.
- [x] Blocked, conflicting, unsupported, private, restricted, duplicate,
  missing-ref, raw-payload, and effect-widened imports do not receive apply
  authority.
- [x] Diagnostics expose counts and no-effect flags without raw memory bodies.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Validation Result

Stopped accepted-memory import apply/admission validated through focused
server, control DTO, CLI, package check, docs QA, Northstar QA, format check,
diff check, and Effigy doctor runs.

The next lane is
`docs/roadmaps/g03/133-accepted-memory-review-product-consumption-readiness.md`.
It keeps accepted memory read-only and focuses on explaining accepted-memory
review/import/apply readiness before any active mutation, SCM sharing,
embeddings/search, provider-native memory sync, automatic extraction, task
mutation, or final UI behavior.

## Stop Conditions

- The work requires creating or updating accepted-memory records.
- The work requires writing projection files.
- The work requires SCM/forge capture, publication, push, PR, merge, or status
  effects.
- The work requires embeddings, search, provider-native memory sync, or
  automatic extraction.
- The work requires task mutation, agent scheduling, callback, interruption,
  recovery, raw payload retention, or final UI behavior.
