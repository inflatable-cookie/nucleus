# 105 Response Envelope Diagnostics Serialization

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../025-diagnostics-control-dto-serialization.md`

## Purpose

Serialize diagnostics query results through control response envelopes.

## Scope

- Map diagnostics result variants to response DTOs.
- Add serialization tests.
- Preserve unsupported and empty diagnostics states.

## Acceptance Criteria

- [x] Response envelopes can carry diagnostics results.
- [x] Unsupported diagnostics serialize distinctly.
- [x] Raw payloads stay absent.

## Outcome

Diagnostics query results now serialize as a first-class control response body
instead of falling back to `query_unsupported`.

## Validation

- `cargo test -p nucleus-server control_envelope`
- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if envelope serialization needs new transport authority.
