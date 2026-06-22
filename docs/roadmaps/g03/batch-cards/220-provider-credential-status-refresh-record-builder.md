# 220 Provider Credential Status Refresh Record Builder

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../061-stopped-provider-credential-status-refresh-control.md`

## Purpose

Build stopped provider credential-status refresh records from credential refs.

## Acceptance Criteria

- [x] Refresh ids derive deterministically from credential ref ids.
- [x] Records preserve credential kind, resolution boundary, current status,
  allowed operation families, provider context ref, status evidence ref, and
  sanitization policy ref.
- [x] Missing refs produce repair-required records.
- [x] Real credential, provider, callback, interruption, recovery, task, and
  raw payload effect requests produce blocked records.
