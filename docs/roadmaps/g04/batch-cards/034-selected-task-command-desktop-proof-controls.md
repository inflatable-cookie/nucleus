# 034 Selected Task Command Desktop Proof Controls

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../007-selected-task-command-admission-controls.md`

## Purpose

Add disposable desktop proof controls for admitted task-only actions after the
server boundary is stable.

## Work

- [x] Render controls only for server-admitted task command candidates.
- [x] Disable or hide blocked, read-only, and deferred gate candidates.
- [x] Require block reason input before block submission.
- [x] Refresh task workflow evidence after server command response.
- [x] Add guard tests that forbid provider/SCM/delegation/review controls.

## Acceptance Criteria

- [x] Desktop remains a client of server command responses.
- [x] Controls are proof-only, not final UI design.
- [x] Provider execution, SCM mutation, delegation scheduling, review
  acceptance, and active apply controls remain absent.

## Result

- Added selected-task command admission query helpers to the desktop control
  client.
- Added disposable task-only proof controls to the drilldown panel.
- Kept blocked, deferred, read-only, provider, SCM, delegation, review, and
  active-apply controls out of the proof surface.
- Added Tauri adapter and panel guard coverage.
