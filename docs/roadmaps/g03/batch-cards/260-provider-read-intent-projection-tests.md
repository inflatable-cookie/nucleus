# 260 Provider Read-Intent Projection Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../069-provider-read-intent-projection-control.md`

## Purpose

Prove the generic read-intent projection groups families and reports aggregate
states without enabling provider work.

## Acceptance Criteria

- [x] Mixed persisted families are grouped and counted.
- [x] Duplicate, blocked, and repair-required states are counted.
- [x] Control DTO serializes sanitized counts only.
