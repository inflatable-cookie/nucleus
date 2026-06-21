# 036 Control Envelope Request Boundary Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the error-sized control envelope request/query boundary into focused
modules without changing the control protocol, serialization, or server
behavior.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move request envelope, body, query, scope, and protocol validation code
  out of `control_envelope_dto.rs`.
- [x] Preserve existing public DTO names and re-exports.
- [x] Keep serialization and decoding behavior unchanged.
- [x] Avoid provider, SCM, UI, remote transport, and task mutation behavior.

## Execution Plan

- [x] Request/query module split batch.
- [x] Protocol/helper split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/121-control-envelope-request-query-module-split.md`
- `batch-cards/122-control-envelope-protocol-helper-split.md`
- `batch-cards/123-control-envelope-boundary-validation-closeout.md`

## Closeout Evidence

- `control_envelope_dto.rs` dropped from 449 lines to 39.
- New focused modules:
  - `control_envelope_dto/request.rs`
  - `control_envelope_dto/query.rs`
  - `control_envelope_dto/protocol.rs`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture` passed.
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- `effigy doctor` remains red but dropped from 157 findings and 29 errors to
  156 findings and 28 errors.

## Acceptance Criteria

- [x] `control_envelope_dto.rs` is reduced to a focused module front door.
- [x] Request/query DTO code lives in named submodules.
- [x] Existing control-envelope tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI
  panel, or task mutation behavior is added.
