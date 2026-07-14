# 167 Window Placement Schema And Fallback

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../032-native-window-geometry-persistence.md`
Auto-start next card: yes

## Objective

Add schema-v3 placement records, migration, normalization, and pure fallback
planning.

## Outcome

- `ui.json` carries display hint, normal bounds, and maximized state.
- Geometry updates merge into the current locked config.
- Pure tests cover display match, intersection recovery, and primary fallback.
