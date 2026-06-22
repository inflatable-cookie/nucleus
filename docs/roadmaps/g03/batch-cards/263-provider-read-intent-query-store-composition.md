# 263 Provider Read-Intent Query Store Composition

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../070-provider-read-intent-query-composition.md`

## Purpose

Compose the generic provider read-intent projection from local-store persisted
refresh records.

## Acceptance Criteria

- [x] Query reads persisted credential-status refresh records.
- [x] Query reads persisted repository-metadata refresh records.
- [x] Query reads persisted PR/MR refresh records.
- [x] Query performs no provider or credential effects.
