# 094 Actor Selector Composer Placement And Visibility

Status: dispatched
Owner: Tom
Created: 2026-08-10
Milestone: none yet (subagent interface lane)
Depends on: 093 (`subagent-group` transcript rendering, merged `7f45481b`)
Auto-start next card: no

## Objective

Fix the two actor-navigation gaps found in the first live subagent test and
make the selector match where the operator's attention actually is:

1. **Stuck child view.** The selector renders only when
   `subagentDirectories.length > 0`, but the actor selection is hydrated
   independently (`AgentChatPanel.svelte` `hydrateHistory`). A failed turn
   can persist a child selection with no directory — the transcript stays
   filtered to the child and no selector renders, so there is no way back.
2. **Placement and prominence.** The selector is a ghost text `Select`
   pinned at the top of the transcript; the operator's focus is the composer
   at the bottom. It goes unnoticed.

## Governing Refs

- `docs/contracts/019-conversation-timeline-contract.md` — Provider Work
  Projection Rule; presentation changes must not alter attribution truth
- `docs/roadmaps/g05/batch-cards/024-subagent-directory-attribution-and-navigation.md`
  — where the selector was introduced
- `docs/roadmaps/g05/batch-cards/093-subagent-group-transcript.md` — the
  group rendering that routes through the same selector
- Live evidence: 2026-08-10 operator test — turn failed server-side during
  a multi-agent spawn; after "Open child work" the child view showed one
  activity line with no visible way back to All work

## Environment Notes

- The desktop app consumes poodle through the local-source link
  (`effigy deps link bun` already applied); poodle `AgentSubagent` and
  `onOpenChild` forwarding are present.
- Existing primitives only — compose from what poodle already exports
  (e.g. `Select`, `Icon`, `Badge`/`Chip` if exported); no poodle source
  changes.

## Worker Rules

- Execute the card exactly; no planning authority; no sub-agents.
- Do NOT touch roadmap/milestone/card/dispatch status files — deliverables +
  batch log only.
- Commit on branch `thread/094-actor-selector-composer-placement` and push
  with `git push -u origin thread/094-actor-selector-composer-placement`;
  no merge.

## Scope

- `apps/desktop/src/lib/agentChatTranscript.ts`: no changes expected; flag
  in the batch log if the fallback needs projection support.
- `apps/desktop/src/lib/AgentChatPanel.svelte`:
  - Remove the `.actor-navigation` block from the transcript shell.
  - Render the actor selector in the composer zone (directly above
    `AgentChatInput`, aligned with the composer width) whenever
    `subagentDirectories.length > 0` **or** the current `actorSelection`
    is a subagent selection.
  - Prominence: a chip-style trigger, not ghost text — icon + current actor
    label (`All work`, `Primary`, or the child label) with the child's
    status reflected (e.g. badge/tone for running vs terminal). Match the
    composer chip row's visual language.
  - Fallback: on hydrate and on directory events, if `actorSelection` is a
    subagent selection with no matching directory entry, reset to `all`
    (persist through `selectAgentChatActor` so server state agrees).
  - `onOpenChild` continues to route through `chooseActor`; selecting
    `All work` remains the return path.
- Tests: extend the existing panel/transcript vitest or bun fixtures for
  the visibility condition and the no-directory fallback.
- Batch log `docs/logs/2026-08-10-actor-selector-composer-placement.md`.

Out of scope: swallowtail or server changes (the spawn-side admission
failure is a separate swallowtail card), poodle source changes, any new
control affordance on subagents (observation-only per swallowtail 045).

## Acceptance

- [ ] selector renders in the composer zone whenever subagent directories
  exist or the current selection is a child
- [ ] selector trigger reads as a chip (icon + label + status), not plain
  ghost text
- [ ] child selection with no directory falls back to `All work`, locally
  and persisted
- [ ] group `onOpenChild` → child view → `All work` round trip works
- [ ] fixtures + `effigy desktop:check` + `effigy desktop:test` pass

## Evidence

- Batch log with commands + exit states and fixture names.

## Stop Conditions

- The fallback requires changing persisted history shape server-side → stop
  and report
- Prominence treatment requires a new poodle primitive → stop and report
  with the proposed API
- Scope pressure toward server, swallowtail, or poodle changes → stop and
  report
