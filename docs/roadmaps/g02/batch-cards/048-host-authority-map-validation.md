# 048 Host Authority Map Validation

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../013-host-authority-map-and-client-protocol-records.md`

## Purpose

Close the host-authority map record lane with validation and follow-on gates.

## Scope

- Run targeted authority-map, protocol DTO, docs, and workspace checks.
- Record any remaining limitations as follow-on cards.
- Decide whether `014-codex-live-runtime-supervision.md` can become active.
- Do not start live provider supervision in this card.

## Acceptance Criteria

- Authority-map records, query shape, and DTOs validate together.
- Next runtime work has a clear gate.
- Remote host behavior remains deferred unless the authority/auth surfaces are
  ready.

## Validation

- `cargo test -p nucleus-server authority_map`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if authority-map records cannot support the planned client read model.

## Outcome

Completed 2026-06-17.

Validation passed for authority-map records, read-only query shape, response
DTOs, workspace check, and docs QA. `014-codex-live-runtime-supervision.md` can
become active. Remote host behavior, pairing, and live network transport remain
deferred.
