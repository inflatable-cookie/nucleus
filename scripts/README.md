# Scripts

Use Effigy from the repo root for the default maintenance loop:

```bash
effigy tasks
effigy doctor
effigy qa
```

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

- `bin/` holds the operator CLI and the MCP reporting bridge.
- `scripts/check-moves.ts` (`effigy check:moves`) compares moved code between two
  refs. Every move PR in lane `nucleus-simplify` runs it and pastes the result.

These tools use Node because the plugin SDK, SQLite and scoped MCP bridge
already depend on it. They resolve repository assets from their own module path,
so they can be invoked from anywhere. Live acceptance scripts mutate workspaces
or GitHub; run them only for an explicitly authorized acceptance scenario.

`effigy check:moves -- --shards <before> <after> <family>...` compares case
registration sites and verifies each revision has a complete shard layout.
