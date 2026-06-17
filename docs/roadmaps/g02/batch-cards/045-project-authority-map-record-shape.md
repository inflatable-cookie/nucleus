# 045 Project Authority Map Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../013-host-authority-map-and-client-protocol-records.md`

## Purpose

Turn the existing host-authority vocabulary into client-visible authority-map
records with validation posture.

## Scope

- Add focused Rust records for project authority-map publication.
- Reuse existing host ids, host forms, authority domains, and assignments.
- Distinguish ownership, fallback, mutation allowance, and publication state.
- Keep authority-map mutation, persistence, remote sync, and transport out of
  scope.
- Update contracts and roadmap state.

## Acceptance Criteria

- Records can describe which host owns each authority domain for a project.
- Records distinguish unassigned, assigned, mutation-denied, fallback, and
  publication-deferred states.
- Client-visible records do not grant authority by themselves.
- No listener, pairing flow, live transport, or remote host behavior is added.

## Validation

- `cargo test -p nucleus-server authority_map`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if mutation semantics, persistence, or cross-host synchronization are
  required to define the record shape.

## Outcome

Completed 2026-06-17.

Added compile-only client-visible authority-map publication records under
`nucleus-server` client protocol. The records project existing host authority
assignments into assigned, mutation-denied, fallback-only, unassigned, and
publication-deferred states with validation issues, without granting authority
or adding persistence/transport behavior.
