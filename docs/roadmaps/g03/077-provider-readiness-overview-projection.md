# 077 Provider Readiness Overview Projection

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Implement the first server-owned product consumption surface for provider
read-intent.

The Provider Readiness Overview projection composes existing stopped
provider-read evidence into one client-safe readiness surface. It is not a
visible UI panel and it does not refresh provider data.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/070-provider-read-intent-query-composition.md`
- `docs/roadmaps/g03/076-provider-read-intent-product-consumption-decision.md`

## Goals

- [x] Define Provider Readiness Overview model types.
- [x] Compose the overview from existing provider read-intent projection data.
- [x] Expose blocker/status/evidence counts without raw provider material.
- [x] Add focused tests for empty, blocked, repair, and represented-read cases.
- [x] Keep provider effects, credential resolution, live reads, and UI work
  blocked.

## Execution Plan

- [x] Model the overview status, input, output, and no-effect flags.
- [x] Add a pure composer over existing read-intent projection data.
- [x] Add focused tests for readiness classification and forbidden material.
- [x] Close with focused Rust validation and docs updates.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/289-provider-readiness-overview-type-surface.md`
- `batch-cards/290-provider-readiness-overview-composer.md`
- `batch-cards/291-provider-readiness-overview-tests.md`
- `batch-cards/292-provider-readiness-overview-validation-closeout.md`

## Acceptance Criteria

- [x] Overview status can represent ready, blocked, needs repair, unknown, and
  unsupported.
- [x] Overview output includes provider, repo, family, blocker, and evidence
  counts only as sanitized refs/counts.
- [x] Empty local evidence produces unknown or unsupported readiness, not ready.
- [x] Missing credential/repo/PR evidence produces blocker counts.
- [x] The composer performs no credential resolution, provider network calls,
  provider effects, task mutation, callback, interruption, recovery, or raw
  provider payload retention.
- [x] Focused tests pass.

## Stop Conditions

- Stop before adding visible UI.
- Stop before adding issue, comment, review workflow, or status/check refresh
  families.
- Stop before calling provider APIs.
- Stop before resolving credentials.

## Closeout

Provider Readiness Overview is implemented as a pure server projection over
existing provider read-intent evidence. It reports readiness status, supported
and represented read families, represented mutating families, sanitized
provider/repo refs, blocker counts, evidence counts, and explicit no-effect
flags without calling providers, resolving credentials, mutating tasks, or
adding UI.
