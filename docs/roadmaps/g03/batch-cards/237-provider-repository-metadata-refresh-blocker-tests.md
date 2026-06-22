# 237 Provider Repository Metadata Refresh Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../064-stopped-provider-repository-metadata-refresh-control.md`

## Purpose

Test repository metadata refresh blockers and control DTO counts.

## Acceptance Criteria

- [x] Provider context refs produce stopped refresh records.
- [x] Missing provider context, provider instance, forge provider, remote repo,
  evidence, and sanitization refs require repair.
- [x] Credential material, provider payloads, real credential resolution,
  provider network calls, callbacks, interruption, recovery execution, task
  mutation, and raw payload retention are blocked.
- [x] Control DTO serialization remains sanitized.
