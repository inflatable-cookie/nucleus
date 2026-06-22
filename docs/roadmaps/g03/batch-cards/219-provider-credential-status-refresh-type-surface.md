# 219 Provider Credential Status Refresh Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../061-stopped-provider-credential-status-refresh-control.md`

## Purpose

Define stopped provider credential-status refresh input, record, set, status,
class, blocker, and control DTO types.

## Acceptance Criteria

- [x] Types consume credential refs without credential material.
- [x] Types carry provider context, status refresh evidence, and sanitization
  policy refs.
- [x] Types represent ready, repair-required, and blocked refresh records.
- [x] Types classify credential status into ready, repair, unknown, and
  unsupported buckets.
- [x] Types expose explicit no-effect flags.
