# 188 Promote Local Host Runtime Discovery Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Promote local host runtime discovery rules into the server boundary contract.

## Scope

- Document what discovery may inspect.
- Document what discovery must not do.
- Document how discovered descriptors feed host-spawn readiness.
- Keep backend implementation work separate from readiness evidence.

## Out Of Scope

- Implementing real backend discovery probes.
- Implementing spawn.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g01/031-local-host-runtime-capability-discovery.md`

## Acceptance Criteria

- Contract explains non-spawning discovery.
- Contract names descriptor output groups.
- Contract states unsupported discovery is a valid result.
- Roadmap reflects promoted boundary.

## Closeout

- Server boundary contract now names local host runtime discovery and
  discovery-to-gate composition.
- Contract states discovery supplies descriptor values while explicit gate
  inputs remain separate.
- Contract states unsupported discovery is valid and must keep readiness
  blocked with backend blockers.
