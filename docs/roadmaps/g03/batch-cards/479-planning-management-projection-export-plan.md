# 479 Planning Management Projection Export Plan

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Compose a read-only export plan from persisted Planning domain records.

## Work

- [x] Read Planning/PlanningArtifact records when available.
- [x] Read Planning/TaskSeed records.
- [x] Produce projection entries without filesystem writes.
- [x] Surface unsupported or decode-failed records as controlled issues.

## Acceptance Criteria

- [x] Export planning is read-only.
- [x] No files are written.
- [x] No SCM/forge mutation occurs.
- [x] Decode failures are controlled.
