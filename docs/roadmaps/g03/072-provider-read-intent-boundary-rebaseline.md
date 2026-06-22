# 072 Provider Read-Intent Boundary Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Rebaseline the provider read-intent boundary before implementing serialized
control-envelope DTO support.

The prior lane exposed provider read-intent projection through the in-process
control handler. This lane checks whether that shape can safely become a wire
surface and records the minimum next implementation scope.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/070-provider-read-intent-query-composition.md`
- `docs/roadmaps/g03/071-provider-read-intent-control-boundary.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`

## Findings

- The in-process provider read-intent query is correctly stopped by default.
- The current serializable envelope intentionally rejects provider read-intent
  results.
- The next lane may add serialized support, but only as a deliberate DTO shape.
- The first DTO should expose aggregate projection/source counts and sanitized
  entry refs, not provider-native payloads.
- Additional read-family fan-out remains paused.
- Provider writes, credential resolution, callback execution, interruption,
  recovery execution, task mutation, and raw-material retention remain blocked.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/270-provider-read-intent-contract-delta.md`
- `batch-cards/271-provider-read-intent-envelope-boundary-audit.md`
- `batch-cards/272-provider-read-intent-next-lane-selection.md`
- `batch-cards/273-provider-read-intent-rebaseline-validation-closeout.md`

## Acceptance Criteria

- [x] Contract records the read-intent serialized DTO rule.
- [x] Architecture/gap surfaces distinguish in-process support from wire DTO
  support.
- [x] Next task points at a bounded serialized DTO lane, not more provider
  read-family fan-out.
- [x] No code changes grant provider write, network, credential, callback,
  interruption, recovery, task mutation, or raw-material authority.
- [x] Docs validation passes.

## Closeout

Provider read-intent is ready for a first serialized control-envelope lane, but
only as a read-only DTO.

The next lane should implement:

- request DTO support for `provider_read_intent` aggregate projection
- response DTO support for aggregate/source counts and sanitized entry refs
- codec tests proving unsupported shapes fail closed
- no provider writes or credential resolution
