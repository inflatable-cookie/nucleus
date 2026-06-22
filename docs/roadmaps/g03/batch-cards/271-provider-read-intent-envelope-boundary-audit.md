# 271 Provider Read-Intent Envelope Boundary Audit

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../072-provider-read-intent-boundary-rebaseline.md`

## Purpose

Audit the current control-envelope state before adding provider read-intent
serialization.

## Acceptance Criteria

- [x] Current query DTO does not accept provider read-intent.
- [x] Current response DTO rejects provider read-intent results.
- [x] In-process handler support remains separate from wire support.
- [x] No accidental internal-Rust-shape serialization is accepted.
