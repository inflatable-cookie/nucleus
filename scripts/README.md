# Scripts

Repo-owned scripts should stay small and justified.

Default policy:

- use Effigy for task routing
- use Rust for product code
- use TypeScript with Bun only when repo-owned automation is needed
- use shell only for thin glue

## Checks

- `verify-longhorn-consumer-boundary.ts` installs the published Longhorn
  renderer packages from the npm registry with the pinned Poodle release
  outside all workspaces, checks the Rust graph against git tag `v0.1.0`, and
  emits sanitized consumer evidence.
