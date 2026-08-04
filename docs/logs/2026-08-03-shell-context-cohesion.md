# Shell Context Cohesion

Date: 2026-08-03
Status: implemented; waits only for next-lane selection

## Outcome

Project selection is now a hard renderer epoch. The old workspace stage
unmounts, launcher and active-panel facts clear, and the next stage restores
only its project's registered layout.

An intentionally empty layout remains empty. The workspace presents one direct
`Open Agent Chat` action while the header `+` menu retains the wider recovery
catalogue. Failure and reconnect state remain inside the workspace, leaving the
project rail usable and avoiding invented reset authority.

The final-panel close exposed a renderer reactivity defect. The stage held its
`WorkspaceLayoutSession` through `$state.raw`, so a close-only session update
could stay invisible until remount. Using normal `$state`, matching the existing
session harness, makes authoritative zero-panel snapshots repaint immediately.

## Evidence

- desktop type checking: pass; one pre-existing ProjectRail accessibility warning
- desktop tests: 54 pass
- production frontend build: pass
- fresh Tauri release bundle: pass
- native last-panel close and direct Agent Chat recovery: pass
- native rapid switching, normal restoration, and relaunch persistence: pass
- authenticated provider work: not run

The native check used a fresh release bundle because the already-installed
debug bundle retained stale renderer assets during development. The temporary
bundle-build flag was reverted after producing the acceptance artifact.

## Boundary

No layout reset, repair command, cross-project default inference, or renderer
layout authority was added. Card 058 remains operator-held only for selection
of the next g05 inward lane.
