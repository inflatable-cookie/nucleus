# 324 Provider Status Check Refresh Record Builder

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Build stopped status/check refresh records from explicit refs and no-effect
flags.

## Acceptance Criteria

- [x] Ready records require provider context, provider instance, remote repo,
  target change, credential-status evidence, status/check evidence, and
  sanitization refs.
- [x] Missing refs produce blocked or repair-required records with sanitized
  blockers.
- [x] Duplicate/no-op handling is deferred to the persistence slice without
  provider calls.
- [x] The builder blocks provider effects, callbacks, recovery execution, task
  mutation, and raw provider payload retention.
