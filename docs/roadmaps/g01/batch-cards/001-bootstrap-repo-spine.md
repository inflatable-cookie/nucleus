# 001 Bootstrap Repo Spine

Status: completed
Owner: Tom
Updated: 2026-06-15

## Goal

Install the strict Northstar docs spine, native Effigy task surface, and minimal
Rust workspace without building app behavior.

## Scope

- Create strict docs spine.
- Add native `effigy.toml`.
- Add empty Rust workspace crates.
- Add app placeholders.
- Add ignored T3 Code reference clone.
- Record harness communication research lane.

## Out Of Scope

- Runnable Tauri app.
- Server API implementation.
- Harness adapter implementation.
- Storage engine selection.
- Release config.

## Acceptance Criteria

- `effigy tasks` shows repo tasks.
- `effigy doctor` has no manifest warning.
- `effigy test --plan` resolves cleanly.
- `effigy qa:northstar` passes.
- `cargo check --workspace` passes.
- T3 Code reference is cloned or a research blocker is logged.
- Docs front doors include one clear `Next Task`.

## Validation

```sh
effigy tasks
effigy doctor
effigy test --plan
effigy qa:northstar
cargo check --workspace
cargo test --workspace
git status --short
```

## Next Task

Draft SCM/forge adapter implementation readiness plan.
