# 074 Provider Read-Intent Nucleusd Query

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose provider read-intent through a thin `nucleusd` query command.

This lane makes the serialized provider read-intent control-envelope shape
inspectable from the root task surface without adding UI, provider writes,
credential resolution, or read-family fan-out.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/071-provider-read-intent-control-boundary.md`
- `docs/roadmaps/g03/072-provider-read-intent-boundary-rebaseline.md`
- `docs/roadmaps/g03/073-provider-read-intent-serialized-control-envelope.md`

## Goals

- [x] Add `nucleusd query provider-read-intent`.
- [x] Render stable sanitized summary lines.
- [x] Expose root Effigy selector for the query.
- [x] Keep output read-only and effect-free.
- [x] Avoid UI expansion.

## Execution Plan

- [x] CLI query vocabulary.
- [x] Query routing and renderer.
- [x] Effigy task selector.
- [x] Focused tests and smoke command.
- [x] Validation and docs closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/278-provider-read-intent-nucleusd-query-vocabulary.md`
- `batch-cards/279-provider-read-intent-nucleusd-renderer.md`
- `batch-cards/280-provider-read-intent-effigy-selector.md`
- `batch-cards/281-provider-read-intent-nucleusd-validation-closeout.md`

## Acceptance Criteria

- [x] CLI parses `query provider-read-intent`.
- [x] Query routes to `ServerQueryKind::ProviderReadIntent`.
- [x] Output includes projection/source counts and no-effect flags.
- [x] Output does not expose credential material or raw provider payloads.
- [x] `effigy server:query:provider-read-intent` runs from repo root.
- [x] Focused tests pass.

## Closeout

Provider read-intent is now inspectable through:

- in-process control handler
- serialized control-envelope DTO
- `nucleusd query provider-read-intent`
- `effigy server:query:provider-read-intent`

The command is still read-only. It performs no credential resolution, provider
network call, provider effect, callback, interruption, recovery execution, task
mutation, or raw provider payload retention.

Next lane:

- choose the next provider read-intent consumption surface before adding UI,
  more read-family fan-out, or provider effects
