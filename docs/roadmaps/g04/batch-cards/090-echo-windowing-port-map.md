# 090 Echo Windowing Port Map

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Inspect the current Loophole Echo windowing/layout source and decide the
minimum Nucleus port map before editing `nucleus-workspaces`.

## Work

- [x] Inspect `../loophole/echo/crates/echo-windowing`.
- [x] Inspect `../loophole/echo/crates/echo-ui-layout`.
- [x] Identify reusable concepts, concepts to rename, and concepts to defer.
- [x] Decide initial module files for `nucleus-workspaces`.
- [x] Record any contract deltas before code edits.

## Acceptance Criteria

- [x] The first code card has a concrete module map.
- [x] The port does not copy Aura panel defaults blindly.
- [x] The first implementation scope is pure Rust and testable.

## Result

`echo-windowing` is the closest first port target. It is compact and already
separates stable window/display identity, host handles, placement config,
planning, shell hosting, lifecycle mutations, restore normalization, and
active-surface fallback.

`echo-ui-layout` contributes the local shell policy and project/user override
ideas, but its panel catalogue/defaults are Loophole-specific and should not
be copied.

No contract delta is needed before the next code card. The existing workspace
layout contract already requires global local client display/window/surface
state, per-project panel rules, renderer non-authority, deterministic
fallback, and local-only persistence.
