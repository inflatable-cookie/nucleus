# 202 Forge Network Preflight Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../057-stopped-forge-network-preflight-control.md`

## Purpose

Test stopped forge network preflight blockers.

## Acceptance Criteria

- [x] Happy-path stopped preflight passes.
- [x] Missing refs produce repair-required state.
- [x] Real effect requests produce blocked state.
- [x] Non-ready admissions and deferred operation families block.

## Validation

- `cargo test -p nucleus-server forge_network_execution_preflight`
