# Scripts

Repo-owned scripts should stay small and justified.

Default policy:

- use Effigy for task routing
- use Rust for product code
- use TypeScript with Bun only when repo-owned automation is needed
- use shell only for thin glue

## Checks

- `verify-longhorn-consumer-boundary.ts` packs the selected private Longhorn
  renderer graph, installs it with the admitted Poodle artifacts outside all
  workspaces, checks the Rust graph, and emits sanitized consumer evidence.
