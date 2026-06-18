# 165 Project Task Projection Export Hardening

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../037-repo-backed-management-sync-hardening.md`

## Purpose

Harden export behavior for project and task management projection files.

## Scope

- Cover project and task projection export with focused tests.
- Preserve deterministic paths and payloads.
- Keep local runtime-only records out of export output.

## Acceptance Criteria

- Export fixtures are deterministic.
- Task and project records remain decodable after export.
- Runtime progress records are excluded unless explicitly allowed by policy.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo test -p nucleus-engine management_projection`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if export policy is still ambiguous.
