# 125 God File Module Splits

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Split the actual high doctor findings into focused modules before the
task-backed runtime lane adds more server, engine, native harness, or desktop
surface area.

## Scope

- Keep public behavior stable.
- Use front-door files as module indexes.
- Split domain types, helpers, codecs, tests, and read models by responsibility.
- Avoid broad redesign.

## Acceptance Criteria

- [x] `scan.god-files` no longer reports high findings.
- [x] Focused Rust and desktop checks pass.
- [x] Module names explain their responsibilities.

## Result

Split high-pressure files across:

- `crates/nucleus-native-harness/src/effigy/`
- `crates/nucleus-native-harness/src/steward/`
- `crates/nucleus-native-harness/src/steward_commands/`
- `crates/nucleus-engine/src/management_projection/`
- `crates/nucleus-engine/src/management_sync/`
- `crates/nucleus-engine/src/task_work_items/`
- `crates/nucleus-server/src/codex_supervision/`
- `crates/nucleus-server/src/diagnostics_read_models/`
- `crates/nucleus-server/src/management_projection_state/`
- `crates/nucleus-server/src/control_envelope_dto/response/records/`
- `crates/nucleus-server/src/control_envelope_dto/tests/response/`
- `apps/desktop/src/lib/control/`

## Validation

- `cargo test -p nucleus-native-harness effigy`
- `cargo test -p nucleus-native-harness steward`
- `cargo test -p nucleus-engine management_projection`
- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-engine task_work_item`
- `cargo test -p nucleus-server codex_supervision`
- `cargo test -p nucleus-server diagnostics_read_models`
- `cargo test -p nucleus-server control_envelope_dto::tests::response`
- `effigy desktop:check`
- `effigy doctor`
- `cargo check --workspace`
- `cargo test --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the split needs behavior changes.
