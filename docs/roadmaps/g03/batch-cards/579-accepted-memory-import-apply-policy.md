# 579 Accepted Memory Import Apply Policy

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../132-accepted-memory-import-apply-admission.md`

## Purpose

Define stopped apply/admission policy for validated accepted-memory projection
imports.

## Work

- [x] Identify which import validation records are eligible for stopped apply
  admission.
- [x] Define required operator approval, candidate, file, conflict,
  provenance, and sanitized evidence refs.
- [x] Define blockers for unresolved conflicts, duplicate no-op, missing refs,
  unsupported schema/kind, unsafe paths, private/restricted visibility, raw
  payload presence, and effect widening.
- [x] Keep active accepted-memory mutation and executor behavior out of scope.

## Decision

Stopped import apply/admission is the next authority layer after read-only
accepted-memory import validation. It answers one question: may this validated
projected memory import be considered by a later active apply executor?

It does not create, update, delete, merge, or supersede accepted-memory records.
It does not write projection files. It does not call SCM/forge providers,
embedding/search systems, provider-native memory sync, extraction systems, task
systems, agent scheduling, callbacks, recovery, or UI apply controls.

Eligible records:

- import candidate was produced by roadmap `131`
- candidate belongs to the requested project
- candidate has a stable memory id and safe file ref under
  `nucleus/memory/<memory-id>.toml`
- candidate decoded with the supported projection schema
- candidate represents an accepted-memory record, not a proposal or unsupported
  record kind
- sensitivity, visibility, retention, and projection policy allow import review
- candidate has sanitized provenance and evidence refs
- operator approval ref is present for this admission step
- conflict review refs are present when prior validation staged a conflict
- duplicate no-op state is represented explicitly instead of silently applying
  work

Required refs:

- admission request id
- import candidate id
- memory id
- project id
- file ref
- operator ref
- approval ref
- provenance refs
- sanitized evidence refs
- conflict review refs when conflict staging was involved

Blocked states:

- missing candidate, memory id, project id, file ref, operator ref, approval
  ref, provenance ref, or evidence ref
- validation-blocked candidate
- unresolved semantic, sensitivity, retention, or supersession conflict
- duplicate no-op without explicit no-op classification
- unsupported schema version, unsupported memory kind, unsafe path, or project
  scope mismatch
- private/restricted memory crossing visibility, retention, or projection policy
- raw transcript, provider payload, source body, terminal stream, credential,
  secret, or raw memory body present
- request attempts active accepted-memory mutation, projection file write,
  SCM/forge mutation, embeddings/search, provider-native sync, automatic
  extraction, task mutation, agent scheduling, callback, interruption,
  recovery, or final UI behavior

The next card should implement deterministic request/record/status/blocker
types from this policy only. Any active apply executor remains blocked.

## Acceptance Criteria

- [x] The selected boundary is explicit enough to implement without guessing.
- [x] Admission does not grant mutation execution.
- [x] The next model card can proceed without reopening UI, provider, SCM,
  search, automatic extraction, task mutation, or active memory authority.
