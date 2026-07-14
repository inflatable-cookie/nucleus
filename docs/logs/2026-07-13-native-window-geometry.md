# Native Window Geometry Closeout

Date: 2026-07-13

Schema-v3 `ui.json` now retains the primary native window's last normal bounds,
maximized state, and best-effort display hint. Rust restores before show,
clamps missing-display placement, coalesces native event writes, and merges
geometry without reverting renderer layout changes.

Focused Rust, desktop, docs, formatting, and diff checks passed. The operator
confirmed size and position restoration across a native restart.
