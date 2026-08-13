# Run Fleet Panel

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/100-run-fleet-panel.md`
Branch: `thread/100-run-fleet-panel`

## Outcome

Added the desktop fleet view as a Runs tab in the project sidebar. The panel consumes the existing `orchestration_runs` control query, groups rows into active, delivered, and terminal lifecycle sections, and renders state, provider/model, recency, closeout presence, and an explicit unavailable-budget label. Failed rows remain visible and direct the operator to the worker thread for the recorded failure receipt reason.

Opening a row uses the run registry's deterministic worker conversation id, `conversation:run:<run_id>`, through the ordinary `nucleus:open-agent-chat-thread` route. The panel refreshes after the existing dispatch thread event and supports retry/error/empty/no-project states.

No server, delivery, closeout, swallowtail, longhorn, or poodle sources were modified. The generated run DTOs were consumed as-is; the current fleet summary does not expose budget burn or receipt-reason fields, so the panel does not invent either value.

## Files

- `apps/desktop/src/lib/RunFleetPanel.svelte`
- `apps/desktop/src/lib/RunFleetPanel.vitest.ts`
- `apps/desktop/src/lib/runFleetPanel.fixture.ts`
- `apps/desktop/src/lib/WorkspaceSidebar.svelte`
- `apps/desktop/src/lib/control/runFleet.ts`
- `apps/desktop/src/lib/control/queryEnvelopeTypes.ts`
- `apps/desktop/src/lib/control.ts`

## Validation

- `effigy desktop:check` — passed (1332 files, 0 errors, 0 warnings).
- `effigy desktop:test` — 71 Bun tests passed; 30 Vitest tests passed, with one pre-existing failure in `src/lib/settings/settingsDialog.vitest.ts`: the General tab did not expose the expected `tabindex="-1"` (known longhorn sweep drift from card 099).
- `git diff --check` — passed.

Delivery review actions and closeout pipeline remain with card 101; this card does not add delivery or closeout controls.
