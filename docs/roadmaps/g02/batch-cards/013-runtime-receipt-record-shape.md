# 013 Runtime Receipt Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first runtime receipt and progress record shape in code.

## Scope

- Receipt id.
- Effect family.
- Requested command/effect refs.
- Status.
- Sanitized summary.
- Artifact/evidence refs.
- Replay-safe projection fields.

## Out Of Scope

- Provider harness runtime.
- SCM effects.
- Live subscriptions.
- Raw stdout/stderr storage.

## Promotion Targets

- `crates/nucleus-engine`
- `crates/nucleus-server`
- `docs/contracts/020-runtime-receipt-contract.md`

## Acceptance Criteria

- [x] Runtime receipt records can represent the existing read-only command proof
  path.
- [x] Receipt records do not contain raw terminal streams or secret-bearing
  payloads.
- [x] Receipt shape is replay-safe and side-effect free.

## Stop Conditions

- The record shape requires provider runtime semantics before a provider target
  is selected.

## Outcome

Added engine-owned runtime receipt record, status, family, ref, and codec
types.
