# 290 Provider Readiness Overview Composer

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../077-provider-readiness-overview-projection.md`

## Purpose

Compose Provider Readiness Overview from existing provider read-intent
projection data.

## Acceptance Criteria

- [x] Composer accepts existing read-intent projection data.
- [x] Empty evidence does not become ready.
- [x] Blocker and evidence counts are deterministic.
- [x] Composer performs no credential resolution, provider network calls, or
  provider effects.

## Stop Conditions

- Stop before adding live refresh behavior.
- Stop before adding new read families.
