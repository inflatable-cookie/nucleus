# 086 Convergence Local Snap Request Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../024-convergence-local-snap-request-persistence.md`

## Purpose

Expose read-only control counts for persisted Convergence local snap requests.

## Acceptance Criteria

- [x] DTO reports persisted, duplicate, blocked, and stopped counts.
- [x] DTO exposes no raw provider payloads or local command output.
- [x] DTO carries no mutation or backend authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_request_control_dto -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
