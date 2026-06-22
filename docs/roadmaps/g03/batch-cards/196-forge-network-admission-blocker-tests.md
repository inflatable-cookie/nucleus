# 196 Forge Network Admission Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../056-stopped-provider-auth-forge-admission-records.md`

## Purpose

Test the stopped admission blockers and serialization boundary.

## Acceptance Criteria

- [x] Happy-path stopped preflight admission passes.
- [x] Missing credential, network, approval, and idempotency refs block.
- [x] Deferred operation and real effect requests block.
- [x] Unready or operation-mismatched credentials block.
- [x] Serialization does not expose secret or provider response fields.

## Validation

- `cargo test -p nucleus-server forge_network_execution_admission`
