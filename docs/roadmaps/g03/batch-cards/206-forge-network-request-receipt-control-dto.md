# 206 Forge Network Request Receipt Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../058-stopped-forge-network-request-receipt.md`

## Purpose

Expose client-safe counts for stopped forge network request/receipt state.

## Acceptance Criteria

- [x] DTO reports recorded, blocked, repair-required, skipped, and blocker
  counts.
- [x] DTO reports all execution flags as false.
- [x] DTO serialization does not expose secret or provider response material.

## Validation

- `cargo test -p nucleus-server forge_network_execution_request_receipt`
