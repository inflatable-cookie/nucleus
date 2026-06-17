# 171 Draft Local Host Execution Safety Strategy

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Draft the local host execution safety strategy before process spawning.

## Scope

- Name which sandbox profiles can be honestly enforced locally.
- Separate advisory labels from enforced restrictions.
- Define first allowed command class for future read-only spawn.
- Keep unsafe profiles blocked.

## Out Of Scope

- Implementing process spawning.
- Implementing OS-specific sandboxes.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`

## Acceptance Criteria

- Sandbox enforcement posture is explicit.
- `NoFilesystemWrite` is not treated as enforced without proof.
- First allowed command class is narrow and testable.

## Closeout

- Promoted local host execution safety strategy into the server boundary
  contract.
- Added architecture wording that current local execution remains gate-only
  until sandbox enforcement is proven.
- Defined the first future local spawn class as read-only, low-risk,
  structured, bounded, summary-only, and enforced-sandbox only.
