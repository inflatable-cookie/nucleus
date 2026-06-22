# 087 Provider Readiness Coverage And Next Provider Gate

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Take stock after the stopped provider read-family fan-out and choose the next
provider lane deliberately.

The previous lanes proved credential status, repository metadata, PR/MR, and
status/check evidence as stopped read-intent records. This lane should decide
whether Nucleus needs more stopped read families, a live-read admission gate, a
credential/auth repair lane, or a product-facing readiness refinement next.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g03/086-stopped-provider-status-check-refresh.md`

## Goals

- [x] Reassess represented provider-readiness evidence families.
- [x] Identify remaining read gaps without assuming more fan-out is useful.
- [x] Define the first live provider read gate if it is the right next move.
- [x] Keep provider effects, provider writes, credential material exposure, task
  mutation, and raw payload retention out of scope unless a later contract
  explicitly grants them.

## Execution Plan

- [x] Audit the current provider-readiness read model and desktop proof.
- [x] Refresh implementation audit and gap index with status/check integration.
- [x] Compare next-lane options: issue/comment/review refresh, live-read
  admission, credential repair, or product read-model hardening.
- [x] Add the selected next roadmap with enough cards to avoid micro-turns.
- [x] Validate docs and targeted code health.

## Batch Cards

Ready cards:

None.

Completed cards:

- `batch-cards/337-provider-readiness-coverage-audit.md`
- `batch-cards/338-provider-readiness-gap-index-refresh.md`
- `batch-cards/339-provider-next-lane-options.md`
- `batch-cards/340-provider-live-read-gate-scope.md`
- `batch-cards/341-provider-next-roadmap-runway.md`
- `batch-cards/342-provider-readiness-gate-validation-closeout.md`

## Acceptance Criteria

- [x] Current provider-readiness coverage is summarized from code and docs.
- [x] Remaining gaps separate stopped read intent, live provider reads,
  provider writes/effects, credential repair, and product UI work.
- [x] Next roadmap is chosen deliberately and does not implicitly authorize live
  provider effects.
- [x] Validation remains green or any failure is recorded as a blocker.

## Coverage Audit

Implemented read families:

- credential status
- repository metadata
- pull-request or merge-request
- status/check

Implementation evidence:

- `provider_forge_readiness_overview` declares four supported read families.
- `provider_forge_read_intent_projection` has family counts for all four.
- `provider_forge_read_intent_query` reads all four persisted source families.
- serialized provider read-intent DTOs expose sanitized counts and family
  labels for all four.
- desktop seed data and provider-readiness tests prove all four represented
  families without live provider refresh.

Remaining read-family gaps:

- issue refresh
- comment refresh
- review workflow refresh

Those gaps are real but lower leverage than a live-read gate. Adding more
stopped read-family modules now would repeat a proven pattern without answering
credential resolution, network authority, payload retention, or live-read
receipt questions.

## Next-Lane Options

Stopped issue/comment/review refresh:

- value: expands provider-readiness coverage
- risk: mechanical fan-out and more provider-surface warnings
- must not authorize: provider network reads or provider writes

Live provider read admission:

- value: proves the missing boundary between stopped evidence and real provider
  observation
- risk: credential and payload handling can widen authority if not separated
- must not authorize: writes, merges, status/check updates, review actions,
  task mutation, or raw payload retention

Credential repair:

- value: makes provider readiness actionable when auth is broken
- risk: can drift into secret handling before the host credential boundary is
  ready
- must not authorize: storing or displaying credential material

Product read-model hardening:

- value: improves visible provider readiness
- risk: proof UI grows before the server model reaches live reads
- must not authorize: durable UI design commitments or provider effects

Recommendation:

- select live provider read admission as a fixture-first lane. It is the
  smallest useful step that moves Nucleus beyond stopped evidence while still
  blocking provider writes and raw material retention.

## Live-Read Gate Scope

The first live provider read gate must separate:

- credential ref selection
- credential status evidence
- host credential-resolution authority
- outbound network authority
- provider endpoint and operation family
- sanitized request identity
- payload retention policy
- response evidence refs
- read receipt refs
- user-visible diagnostics

Defaults:

- credential material absent from durable records
- raw provider payload absent from durable records
- response summaries sanitized before persistence
- live network execution blocked until an explicit later execution card
- provider writes, merges, review workflow mutations, status/check writes,
  task mutation, and callback/recovery execution outside scope

## Current Slice

Next:

- implement `g03/088` provider live-read admission gate through fixture-backed
  records, preflight, sanitized request/receipt planning, and diagnostics
  before any real provider network call.

## Stop Conditions

- Stop before live provider network calls.
- Stop before credential resolution.
- Stop before provider writes, merge, status/check writes, or review workflow
  mutation.
- Stop before raw provider payload retention.
