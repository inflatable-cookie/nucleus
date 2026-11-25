# Scripts

Run `effigy tasks` from the repo root to find a selector. Use the
[scoped checks](../AGENTS.md#validate) while editing. Full `effigy qa` belongs
to [milestone QA](../docs/knowledge/contracts/milestone-qa.md).

## Runtime Policy

- prefer `effigy` when it already covers the operation
- when repo-owned script logic is still needed, default to `TypeScript` run
  with `bun`
- use `bash` only for thin glue or compatibility boundaries
- use `python` or another runtime only with a concrete technical reason

## Working Rule

Keep custom scripts small, readable, and clearly subordinate to the Effigy
task surface rather than growing a parallel workflow system.

## Layout

- `engine/nucleus-dispatch` routes the installed command to the Rust engine.
- `scripts/build-web.mjs` builds the browser assets used in the staged release.
- `scripts/check-moves.ts` (`effigy check:moves`) compares moved code between two
  refs. Every move PR in lane `nucleus-simplify` runs it and pastes the result.

Node runs the browser build, source checks and test runners. Use the
repository selectors for maintenance. Live acceptance scripts mutate workspaces
or GitHub; run them only for an explicitly authorized acceptance scenario.

`effigy check:moves -- --shards <before> <after> <family>...` compares case
registration sites and verifies each revision has a complete shard layout.
