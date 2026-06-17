# 253 Verify Command Diagnostics Panel

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Verify the command diagnostics panel beyond type-checking.

## Scope

- Run desktop Svelte checks.
- Run Rust desktop tests.
- Use a browser or preview pass where practical.
- Record any visual or runtime blocker.

## Out Of Scope

- Polishing final UI.
- Remote server testing.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- Validation commands are recorded.
- Any visual blocker is explicit.
- No hidden runtime error is ignored.

## Outcome

Validation ran `cargo test --workspace`, `effigy desktop:check`,
`effigy desktop:build`, docs QA, and a local dev-server `curl` check. T3
preview automation reported no desktop browser host for this thread, so a
screenshot pass was not available.
