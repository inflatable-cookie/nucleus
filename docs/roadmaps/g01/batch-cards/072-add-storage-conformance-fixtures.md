# 072 Add Storage Conformance Fixtures

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add storage conformance fixtures before backend behavior.

## Scope

- Add in-memory test fixture surfaces for repository conformance.
- Prove create/read/update/list behavior for first domains without SQLite.
- Include fixture coverage for project tool integration records where the
  generic repository trait can cover them.
- Keep fixtures test-only where possible.

## Out Of Scope

- Production database behavior.
- Projection import/export.
- Runtime scheduler.

## Validation

```sh
cargo test --workspace
```

## Decisions

- The first fixture is an in-memory `LocalStoreRepository` implementation.
- The fixture is generic over persisted record domains.
- Revision expectations are enforced in the fixture.
- Non-autocommit transaction posture is rejected because backend transactions
  are not implemented yet.
- Fixture records remain opaque payloads, so no serialization format is chosen.

## Closeout

`nucleus-local-store` now has an in-memory conformance fixture that proves
create, read, update, list, delete, stale revision rejection, cross-domain
rejection, and transaction-posture rejection for the first generic domains,
including project tooling / Effigy integration records.

No SQLite implementation, production repository behavior, projection
import/export, runtime scheduler, or durable persistence was introduced.
