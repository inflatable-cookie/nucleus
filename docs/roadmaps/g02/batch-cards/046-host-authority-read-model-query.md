# 046 Host Authority Read Model Query

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../013-host-authority-map-and-client-protocol-records.md`

## Purpose

Expose authority-map records through a read-only control query for clients.

## Scope

- Add a read-only query shape for project authority-map records.
- Route the query through the local request handler if the backing record shape
  is stable.
- Keep authority mutation and remote synchronization out of scope.
- Return explicit unsupported/deferred responses where backing state does not
  exist yet.

## Acceptance Criteria

- Clients can ask for authority-map read models without mutating state.
- Missing authority-map state is explicit, not fabricated.
- The query does not imply transport or remote auth behavior.

## Validation

- `cargo test -p nucleus-server authority_map`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if query behavior requires a persistent authority-map repository that
  has not been defined.

## Outcome

Completed 2026-06-17.

Added a read-only project authority-map query and handler route. Until an
authority-map repository exists, the handler returns an explicit deferred
publication record instead of fabricating assignments. Response DTO support is
intentionally deferred to `047`.
