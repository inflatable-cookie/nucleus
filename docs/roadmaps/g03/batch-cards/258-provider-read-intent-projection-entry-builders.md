# 258 Provider Read-Intent Projection Entry Builders

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../069-provider-read-intent-projection-control.md`

## Purpose

Build generic read-intent projection entries from the three persisted stopped
read families.

## Acceptance Criteria

- [x] Credential-status records become credential-status read-intent entries.
- [x] Repository metadata records become repository metadata read-intent
  entries.
- [x] PR/MR records become pull-request read-intent entries.
- [x] Entry construction performs no provider or credential effects.
