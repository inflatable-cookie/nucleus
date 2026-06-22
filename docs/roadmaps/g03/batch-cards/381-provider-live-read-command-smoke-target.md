# 381 Provider Live Read Command Smoke Target

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../096-provider-live-read-command-runner-smoke-approval.md`

## Purpose

Add a command-runner smoke target for repository metadata refresh.

## Acceptance Criteria

- [x] Target records reference repo, descriptor, and handoff ids.
- [x] Target records identify `gh repo view` as read-only.
- [x] Target records cannot express provider writes or task mutation.
