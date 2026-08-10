# Actor Selector Composer Placement And Visibility

Date: 2026-08-10
Card: `docs/roadmaps/g05/batch-cards/094-actor-selector-composer-placement.md`
Branch: `thread/094-actor-selector-composer-placement`

## Outcome

Fixed the two actor-navigation gaps from the first live subagent test, both in
`apps/desktop/src/lib/AgentChatPanel.svelte`.

- The `.actor-navigation` ghost `Select` is gone from the transcript shell.
- The actor selector now renders in the composer zone, directly above
  `AgentChatInput`, aligned to the composer column, whenever
  `subagentDirectories.length > 0` **or** the current `actorSelection` is a
  child selection — including a dangling one, so a stuck child view always has
  a way back.
- The trigger is a chip, matching the composer's attachment-chip language
  (subtle border, elevated fill, control radius): leading icon (`users` for
  All work, `user` for Primary, `git-branch` for a child), current actor
  label, and the selected child's status reflected through poodle's
  `StatusIndicator` (`pending` pulsing while running, `success` completed,
  `danger` failed/interrupted, `info` waiting, `neutral` otherwise). The
  badge wording comes from poodle-core `subagentStatusLabel`, the same
  vocabulary the `AgentSubagent` group badge renders, so it cannot drift.
- New `reconcileActorSelection()` fallback: on hydrate and on directory
  events, a child selection whose operation/child has no matching directory
  entry resets to All work — locally first, then persisted through
  `selectAgentChatActor` so server state agrees.
- `onOpenChild` still routes through `chooseActor`; selecting All work remains
  the return path.

No poodle source changed (existing primitives only: `Select` trigger snippet,
`Icon` by lucide name, `StatusIndicator`); no server or swallowtail change;
no new control affordance on subagents. `agentChatTranscript.ts` needed no
changes — the fallback is pure panel state reconciliation and needs no
projection support (flagged per the card's scope note: not needed).

## Fixtures

- `rides with the composer as a chip whenever attributed work exists` —
  asserts the `.actor-navigation` block is gone, the selector sits in the
  composer zone above `AgentChatInput`, the visibility condition
  (`subagentDirectories.length > 0 || actorSelection.kind === "subagent"`),
  the chip markup (icon + label + `StatusIndicator`), and the All work return
  path through `onOpenChild` → `chooseActor`.
- `resets a dangling child selection to All work on hydrate and directory
  events` — asserts the reconcile runs after both history retention and
  directory-event retention, only for a subagent selection, only when no
  directory entry matches the operation and child, and persists the reset
  through `selectAgentChatActor`.

## Commands And Exit States

1. `bun test src/lib/agentChatTranscript.test.ts` — exit 0; 24 passed
   (22 existing + 2 new placement fixtures).
2. `effigy desktop:check` — exit 0; 1255 files, 0 errors, 0 warnings. First
   run flagged one unused-selector warning (`.actor-selector-chip > .poodle-icon`
   without `:global()` on the child-component class); fixed with
   `> :global(.poodle-icon)`, second run clean.
3. `effigy desktop:test` — exit 0; 71 Bun tests across 13 files and 10 Vitest
   files / 23 tests passed.
4. `git diff --check` — exit 0.

No roadmap, milestone, card, dispatch, or status file was changed.
