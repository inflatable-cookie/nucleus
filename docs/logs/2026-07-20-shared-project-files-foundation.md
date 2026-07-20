# Shared Project Files Foundation

Date: 2026-07-20

## Outcome

Projects can explicitly bind one attached Git resource as the Shared project
files target. The server owns the target, sync policy, target health, and
repository-root resolution. Projects without a binding remain unchanged.

## Boundary

- binding never infers the first or default repository
- plain folders and resources owned by another host are refused
- one of `manual`, `assisted`, `automatic`, or `reviewed` is stored explicitly
- export planning is scoped to the selected project and its tasks
- export and import staging resolve the configured root on the authority host
- projected files remain a portable projection, not active runtime state

## Product Surface

Shared project files lives behind the project overflow menu. The compact view
supports configure, policy change, target health, resource repair handoff, and
detach. New project and New chat remain untouched.

## Validation

- 57 focused management-projection tests pass.
- Bound export/import, persistence, missing-resource repair, detach, and
  disabled-projection behavior pass.
- Desktop checks and 14 focused client tests pass.
- The operator confirmed the compact project-menu workflow on 2026-07-20.

The lane is complete. Projected files remain optional and non-authoritative.
