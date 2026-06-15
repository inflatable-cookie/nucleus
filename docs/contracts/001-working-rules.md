# 001 Working Rules

Status: active
Owner: Tom
Updated: 2026-06-15

## Scope

These rules apply to all nucleus work before v1.0.

## Rules

- Use Effigy for task routing and validation when available.
- Use Northstar docs as the project authority surface.
- Keep implementation behind docs until architecture and contracts are clear.
- Prefer small Rust crates with testable boundaries.
- Do not add compatibility shims, aliases, or silent fallbacks before v1.0
  without operator approval.
- Do not turn provider-specific harness behavior into a fake uniform interface.
- Do not let Tauri own durable server state.
- Keep external source references ignored unless explicitly vendored later.

## Closeout Shape

End-of-turn summaries should state:

- what changed
- current state
- validation only if failed or material
- next move

## Next Task

Apply these rules while promoting harness research into contract text.
