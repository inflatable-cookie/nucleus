# 390 Provider Live Read Approved Smoke Evidence Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../098-provider-live-read-approved-smoke-evidence-control-surface.md`

## Purpose

Add serialized control DTOs for approved smoke evidence diagnostics.

## Acceptance Criteria

- [x] Request DTO round-trips the diagnostics query.
- [x] Response DTO exposes counts and no-effect flags only.
- [x] DTO tests reject execute-style actions.
