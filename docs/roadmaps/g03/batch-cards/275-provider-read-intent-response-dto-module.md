# 275 Provider Read-Intent Response DTO Module

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../073-provider-read-intent-serialized-control-envelope.md`

## Purpose

Add focused response DTOs for provider read-intent query results.

## Acceptance Criteria

- [x] Provider read-intent response DTOs live in a focused module.
- [x] Response body has an explicit provider read-intent variant.
- [x] DTOs expose aggregate/source counts and sanitized entry refs.
- [x] DTOs expose no-effect flags.
- [x] DTOs do not serialize internal Rust structs directly as the wire
  contract.
