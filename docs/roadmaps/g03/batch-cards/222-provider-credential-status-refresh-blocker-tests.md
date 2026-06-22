# 222 Provider Credential Status Refresh Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../061-stopped-provider-credential-status-refresh-control.md`

## Purpose

Test credential-status refresh blockers, status classes, and control DTO
counts.

## Acceptance Criteria

- [x] Ready credential refs produce stopped refresh records.
- [x] Expired, unsupported, and unknown credential refs classify separately.
- [x] Missing provider context, status evidence, and sanitization refs require
  repair.
- [x] Credential material, provider payloads, real credential resolution,
  provider network calls, callbacks, interruption, recovery execution, task
  mutation, and raw payload retention are blocked.
- [x] Control DTO serialization remains sanitized.
