# 378 Provider Live Read Command Result Mapping

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../095-provider-live-read-executor-command-runner-handoff.md`

## Purpose

Map read-only command-runner results into sanitized provider live-read output
and receipt records.

## Acceptance Criteria

- [x] Successful stdout can feed the repository metadata parser.
- [x] Parse errors become sanitized blocker records.
- [x] Raw stdout/stderr is not retained in provider executor records.
