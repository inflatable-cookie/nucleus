# 432 Server Client Control Envelope Parity

Status: planned
Owner: Tom
Updated: 2026-06-23
Milestone: `../108-server-client-workflow-hardening.md`

## Purpose

Add or repair serialized control-envelope support for the selected read-only
model if the gap matrix shows it is missing.

## Acceptance Criteria

- [ ] Request and response DTOs serialize sanitized data only.
- [ ] Unsupported or mutating actions fail closed.
- [ ] Focused codec/request tests cover success and rejection paths.
