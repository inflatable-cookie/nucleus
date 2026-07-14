# 168 Tauri Window Restore And Capture

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../032-native-window-geometry-persistence.md`
Auto-start next card: yes

## Objective

Restore placement before first show and retain native geometry without noisy
disk writes.

## Outcome

- Tauri starts hidden, restores bounded placement, then shows the window.
- Move, resize, scale, blur, and close events capture placement.
- One worker coalesces writes; close waits briefly for its flush.
