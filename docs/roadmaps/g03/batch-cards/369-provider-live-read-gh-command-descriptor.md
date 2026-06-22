# 369 Provider Live Read Gh Command Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../093-provider-live-read-server-owned-executor.md`

## Purpose

Add a read-only `gh repo view` command descriptor for repository metadata
refresh.

## Acceptance Criteria

- [x] Descriptor uses selected `--json` fields only.
- [x] Descriptor cannot express provider writes.
- [x] Descriptor names expected sanitized output fields.
- [x] Tests prove argv shape.
