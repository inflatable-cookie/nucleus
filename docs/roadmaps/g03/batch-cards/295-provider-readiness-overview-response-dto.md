# 295 Provider Readiness Overview Response DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../078-provider-readiness-overview-query-control.md`

## Purpose

Add serialized response DTO support for Provider Readiness Overview.

## Acceptance Criteria

- [x] Response DTO includes status, represented read families, mutating family
  names, sanitized refs/counts, and no-effect flags.
- [x] Response DTO omits credential material, raw headers, raw request/response
  bodies, and raw provider payloads.
- [x] Unsupported or unknown query actions fail closed where applicable.
