# Terminal Browser Resource Host Cohesion

Date: 2026-08-04
Roadmap: `../roadmaps/g05/022-terminal-browser-resource-host-cohesion.md`

## Result

Terminal and Browser now behave as sparse project tools without pretending
they share the same runtime boundary.

- one effective resource target feeds both Terminal chrome and host requests
- ambiguous and broken target state stays visible and never falls back by list
  order
- the embedded Terminal checks resource authority before resolving a path or
  starting a PTY
- zero-resource projects use the host fallback only when the project itself is
  local to that host
- healthy embedded Terminal state adds no permanent status chrome
- actual non-local Terminal host identity comes from the live session snapshot
- Terminal opening and failed-open retry stay bounded to the panel and retain
  the exact project, panel, and resource identity
- Terminal colors resolve from the active Poodle theme tokens
- Browser remains a local native child, carries no project-resource selector,
  and retries only its stable panel-local island
- active panel bodies now derive directly from the authoritative workspace
  snapshot, so Browser and Terminal replace each other immediately

## Native Findings

The first current-bundle proof exposed a renderer integration defect: tab
activation persisted correctly, but the region body snippet retained its old
panel. The region now receives the active panel id as a reactive argument and
keys the body on that value.

The rebuilt isolated bundle then passed Browser -> Terminal -> Browser
switching. Terminal produced a live marker on the same theme canvas with no
black surround. Browser returned without recreation. The toolbar panel menu
remained accessible above Browser content. After a full app quit and relaunch,
the saved Browser tab and Browser body restored together.

## Evidence

- resource and Terminal presentation Bun fixtures: 9 passed
- full desktop Bun tests: 49 passed
- mounted desktop tests: 18 passed
- desktop panel guards: 11 passed
- resource-target Rust fixtures: 8 passed
- Terminal runtime Rust fixtures: 6 passed
- Rust workspace check: passed
- Svelte check and desktop production build: passed
- docs QA, Rust formatting, and diff hygiene: passed
- authenticated provider work: not run

Effigy Doctor still reports the pre-existing oversized-file findings and the
generated-in-source warning. Focused Rust tests also retain unrelated unused
test-import warnings. This lane added neither category.

Remote Terminal transport remains gated. A remote resource now fails closed
instead of accidentally running on the desktop host.

## Next

Operator checkpoint. Use the consolidated panels, then select the next g05
inward band: Memory/settings/provider-control placement, or another product
priority.
