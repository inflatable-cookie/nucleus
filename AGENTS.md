# Nucleus Agents

This file applies to the whole repository.

## Start Here

```sh
effigy tasks
effigy doctor
effigy test --plan
```

Then prefer `effigy <task>` for supported repo work before falling back to raw
tools.

Do not add `package.json` scripts that re-export Effigy tasks.

## Docs Authority

- `docs/README.md`
- `docs/vision/README.md`
- `docs/architecture/README.md`
- `docs/contracts/README.md`
- `docs/specs/README.md`
- `docs/roadmaps/README.md`
- `docs/logs/README.md`

## Project Posture

Nucleus starts in strict Northstar posture.

- specs are provisional planning surfaces
- architecture records realized structure
- contracts hold durable rules and boundaries
- roadmaps sequence work
- logs record meaningful decisions and evidence

Do not implement server, Tauri, or harness behavior before the relevant
contracts are clear enough to test.

## Rust Code Shape

Keep Rust code in small, focused modules.

- use `lib.rs` as the crate front door and module index
- split domain types, traits, adapters, and runtime logic into named files
- avoid large catch-all modules unless a crate is still only a placeholder
- prefer clear module boundaries over dumping unrelated types into one file

## Continuation Rule

In a strict Northstar lane, a bare `continue` should be enough.

Treat it as:

- resume from the previous closeout's `Next Task`
- re-anchor on the current ready card or explicit stop/reassessment step
- stay inside the bounded lane unless file state requires a stop

## Planning Ambiguity Rule

When planning is needed and the next direction is not settled in the repo's
authority surfaces, stop and ask for operator intent instead of guessing.

## Reporting Rule

For meaningful checkpoint replies:

- lead with what changed
- state current lane state
- mention validation only when it failed or changes confidence
- state the next move

Use glue-light writing. See `docs/policy/internal-writing-style.md`.
