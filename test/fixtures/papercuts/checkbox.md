# Papercuts

## Open

### [ ] Queue worktrees steal shared gateway routes — 2026-09-25
- Friction: per-worktree compose projects register the same hostname.
- Impact: signed-in tests cannot keep their API for a session.
- Possible fix: use worktree-unique hostnames.
- Surface: infra/workspace.toml
- Unexpected: preserve this field.

### [x] Old issue — 2026-09-20
- Friction: already fixed.

## Resolved

### [ ] Old heading — 2026-09-18
- Friction: also fixed.
