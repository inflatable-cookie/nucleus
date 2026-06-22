# 370 Provider Live Read Sanitized Output Records

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../093-provider-live-read-server-owned-executor.md`

## Purpose

Parse field-limited provider metadata into sanitized evidence records.

## Acceptance Criteria

- [x] Records include repo, visibility, default branch, permission class, and
  update timestamps where present.
- [x] Raw response bodies, headers, and credential material are not retained.
- [x] Parse errors become sanitized blocker evidence.
