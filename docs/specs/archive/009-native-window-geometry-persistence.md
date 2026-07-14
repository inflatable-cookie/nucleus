# 009 Native Window Geometry Persistence

Status: completed
Owner: Tom
Updated: 2026-07-13

## Decision

`~/.nucleus/config/ui.json` schema v3 stores one primary-window placement:
best-effort display key, last normal outer bounds, and maximized state.

Rust restores before first show and captures native events. Writes are
coalesced, merge into latest config, and flush on close. Missing displays
resolve by bounds intersection, primary display, then first available display.
Restored bounds are clamped into the selected work area.

## Outcome

The operator confirmed size and position survive a native desktop restart.
Durable rules now live in contract 006 and product workflow architecture.
