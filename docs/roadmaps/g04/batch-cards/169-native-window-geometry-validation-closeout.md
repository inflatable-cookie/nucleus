# 169 Native Window Geometry Validation Closeout

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../032-native-window-geometry-persistence.md`
Auto-start next card: no

## Objective

Validate schema migration, geometry fallback, desktop integration, docs, and
restart-boundary behavior; then close the lane.

## Validation

- `cargo check -p nucleus-desktop`
- focused window geometry and config tests
- `effigy desktop:check`
- `effigy qa:docs`
- `cargo fmt --all -- --check`
- `git diff --check`

## Next

Stop for operator restart smoke and next product-lane selection.

## Outcome

- Focused config and fallback tests pass.
- Desktop and docs checks pass.
- Operator restart smoke confirms size and position restoration.
