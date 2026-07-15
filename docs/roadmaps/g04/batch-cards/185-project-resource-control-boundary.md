# 185 Project Resource Control Boundary

Status: completed
Owner: Codex
Updated: 2026-07-15
Milestone: `../037-project-resource-foundation.md`
Auto-start next card: yes

## Objective

Expose server-owned project and resource summaries plus typed mutation
admission without granting project authority to Tauri.

## Acceptance

- read models preserve resource identity, kind, role, host, health, and defaults
- mutations carry expected revision, actor, and authoritative-host checks
- control DTOs do not expose unsanitized host paths to unauthorized clients
- unsupported resource kinds fail closed

## Stop Conditions

- client-local state becomes mutation authority
- DTO shape assumes the desktop and server share a filesystem

## Outcome

Project control records now expose retention plus zero-to-many sanitized
resource summaries with stable identity, kind, role, authority host, health,
and working/management defaults. Host-local locators, history, Git remotes,
repair notes, working subdirectories, and projection policy refs stay behind
the server boundary.

The server also owns a pure typed resource-mutation admission gate. Candidates
carry actor, expected project revision, resource kind, and authority host;
missing actors, stale revisions, wrong hosts, and unknown wire kinds fail
closed. Admission performs no persistence or filesystem effects.
