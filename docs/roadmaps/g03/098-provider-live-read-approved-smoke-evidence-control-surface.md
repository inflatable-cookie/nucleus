# 098 Provider Live Read Approved Smoke Evidence Control Surface

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose approved provider live-read smoke evidence diagnostics through read-only
server query/control surfaces.

This lane should make promoted selected-field smoke evidence inspectable from
the control API and `nucleusd` without re-running `gh`, resolving credentials,
triggering UI-driven provider reads, or granting provider write/effect
authority.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/097-provider-live-read-approved-smoke-evidence-promotion.md`

## Goals

- [x] Add query vocabulary for approved smoke evidence diagnostics.
- [x] Add serialized response DTOs for selected diagnostics only.
- [x] Add request-handler and `nucleusd` inspection routing.
- [x] Keep the query read-only and non-executing.

## Execution Plan

- [x] Add server query/result vocabulary and query composer.
- [x] Add control DTO serialization and tests.
- [x] Add request-handler, CLI domain, Effigy selector, and renderer.
- [x] Validate and stop before UI-triggered provider reads or broader provider
  fan-out.

## Batch Cards

Completed cards:

- `batch-cards/389-provider-live-read-approved-smoke-evidence-query-vocabulary.md`
- `batch-cards/390-provider-live-read-approved-smoke-evidence-control-dto.md`
- `batch-cards/391-provider-live-read-approved-smoke-evidence-nucleusd-effigy-query.md`
- `batch-cards/392-provider-live-read-approved-smoke-evidence-validation.md`

## Acceptance Criteria

- [x] Control query returns promoted evidence diagnostics without running `gh`.
- [x] DTO exposes counts and no-effect flags only.
- [x] `nucleusd query provider-live-read-smoke-evidence` prints sanitized
  diagnostics.
- [x] Effigy has a matching root selector.

## Current Slice

Completed:

- implemented cards 389-392 as one read-only inspection batch.
- next lane should pause for provider boundary selection before more read
  fan-out, persistence, or UI-triggered provider execution.

## Stop Conditions

- Stop before automatic provider command execution.
- Stop before UI-triggered provider reads.
- Stop before provider writes, comments, status/check writes, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before storing raw provider stdout/stderr, headers, response bodies, or
  credential material.
