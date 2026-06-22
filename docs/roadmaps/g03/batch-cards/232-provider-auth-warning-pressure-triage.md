# 232 Provider Auth Warning Pressure Triage

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../063-provider-auth-stopped-boundary-health-rebaseline.md`

## Purpose

Record provider-auth warning-sized file pressure without creating refactor
churn.

## Acceptance Criteria

- [x] Line counts are refreshed for stopped provider-auth modules.
- [x] Warning-sized files are recognized as existing fixture-heavy tests or
  broad type surfaces.
- [x] Newly added credential-status persistence files remain below warning
  thresholds.
- [x] No behavior-neutral refactor is started inside the rebaseline lane.
