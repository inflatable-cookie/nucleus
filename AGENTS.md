# Nucleus Agents

Scope: whole repository.

## Always-loaded boundaries

- Use the repository's canonical docs and ready-card surfaces; do not invent a
  parallel planning authority.
- In this repo, normal-mode agents use the current checkout and follow the
  task's canonical docs. Worker mode is active only when an orchestrator-
  dispatched handoff under `docs/handoffs/` declares worker mode; read that
  handoff for its execution contract instead of inferring worker mode from a
  path, branch, or harness.
- If planning authority does not settle the next direction, stop and ask. Keep
  continuation inside the current bounded lane.
- Do not implement server, Tauri, or harness behavior before the relevant
  contracts are clear enough to test.
- Do not run release mutations or change CI or workflow files without an explicit
  request.

## Common commands

```sh
effigy tasks
effigy doctor       # only when routing or environment state is uncertain
effigy test --plan
```

Then prefer `effigy <task>` for supported repo work before falling back to raw
tools. Do not add `package.json` scripts that re-export Effigy tasks.

## Docs authority

- `docs/README.md`
- `docs/vision/README.md`
- `docs/architecture/README.md`
- `docs/contracts/README.md`
- `docs/specs/README.md`
- `docs/roadmaps/README.md`
- `docs/logs/README.md`
- `docs/contracts/001-working-rules.md`
- `docs/contracts/034-agent-instruction-surface-contract.md`
- `docs/contracts/035-agent-local-paths-contract.md`

During execution, record a small recurring solvable hurdle in `PAPERCUTS.md`
according to the working-rules contract; do not make that observation unplanned
work.

## Project posture

Nucleus starts in strict Northstar posture.

- specs are provisional planning surfaces
- architecture records realized structure
- contracts hold durable rules and boundaries
- roadmaps sequence work
- logs record meaningful decisions and evidence

## Rust code shape

Keep Rust code in small, focused modules.

- use `lib.rs` as the crate front door and module index
- split domain types, traits, adapters, and runtime logic into named files
- avoid large catch-all modules unless a crate is still only a placeholder
- prefer clear module boundaries over dumping unrelated types into one file

## Read on demand

Use nested `AGENTS.md` files for path-specific rules, contracts for durable
boundaries, guides for procedures, and skills for task-specific workflows.
Continuation, batch size, planning ambiguity, reporting, worker mode, and
papercuts rules live in `034-agent-instruction-surface-contract.md`. Local path
registry rules live in `035-agent-local-paths-contract.md`. Writing style lives
in `docs/policy/internal-writing-style.md`.
