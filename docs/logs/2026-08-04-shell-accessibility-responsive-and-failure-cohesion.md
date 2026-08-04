# Shell Accessibility Responsive And Failure Cohesion

Date: 2026-08-04
Roadmap: `../roadmaps/g05/024-shell-accessibility-responsive-and-failure-cohesion.md`
Cards: 076-081

## Changed

- Project selection now uses a native button. Double-click and the project menu
  enter the same inline rename field; keyboard focus, Escape, and commit remain
  local to that field.
- Tasks, Agent Chat, Editor, Diff, and Forge Diff adapt to named inline-size
  containers instead of the native-window viewport.
- Project, Threads, Tasks, Memory, Files, Forge, Browser, Terminal, and workspace
  state now distinguish quiet loading/status from actionable local alerts.
- Read retries rerun the exact owning query. Mutation failure is never replayed
  automatically. No global status strip or generic retry executor was added.
- The narrow Project rail contracts its count to a number while retaining the
  full accessible label.

## Evidence

- 57 Bun fixtures and 23 mounted Vitest fixtures pass.
- Svelte check reports zero errors and zero warnings.
- Production desktop build and Rust check pass.
- An isolated fixture-backed native launch at the supported 900 by 680 minimum
  showed semantic project controls, usable Agent Chat controls, Tasks refresh,
  and the Tasks empty state without normal-chrome horizontal scrolling.
- Responsive policy fixtures guard named containers and prevent panel viewport
  media queries from returning.

## Boundaries

- Responsive presentation does not persist measured widths or breakpoints.
- Browser, Terminal, task, memory, file, and SCM authority did not change.
- No authenticated provider work or remote host effect ran.
- Doctor's pre-existing oversized-file and generated-source findings remain
  structural debt outside this lane.

## Next

Use the completed shell-inward pass and select the next bounded g05 product
priority before compiling another roadmap.
