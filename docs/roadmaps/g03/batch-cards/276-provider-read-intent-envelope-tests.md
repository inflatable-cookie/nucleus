# 276 Provider Read-Intent Envelope Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../073-provider-read-intent-serialized-control-envelope.md`

## Purpose

Prove provider read-intent request and response DTO behavior.

## Acceptance Criteria

- [x] Projection request round-trips through JSON.
- [x] Unsupported action rejects with unsupported payload shape.
- [x] Response serializes sanitized counts and refs.
- [x] Response test proves no effect flags are false.
- [x] Response test rejects obvious raw credential/provider material strings.
