# 165 Update Server Storage Project Authority Wording

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Update server, storage, and project contracts so authority comes from the
assigned engine host, not from a global server assumption.

## Scope

- Update server boundary purpose and authority wording.
- Update storage authority wording.
- Update project identity authority map wording.

## Out Of Scope

- Renaming `nucleus-server`.
- Rust refactors.
- Host registry implementation.

## Promotion Targets

- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`

## Acceptance Criteria

- Contracts distinguish host connection from domain authority.
- Embedded desktop, sidecar, and remote hosts are possible under the wording.
- Old server-owned phrasing is either replaced or explicitly reinterpreted.

## Closeout

- Updated server boundary, storage, project identity, working rules, and
  contract index wording around authoritative engine hosts.
- Host connection and project authority are now distinct.
