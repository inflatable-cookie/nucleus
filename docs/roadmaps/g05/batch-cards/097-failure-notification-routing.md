# 097 Operator-Facing Failure Routing Into The Notification Ledger

Status: completed
Owner: Tom
Created: 2026-08-11
Milestone: none yet (shell quality lane)
Depends on: none (presentation half is card 096; independent)
Auto-start next card: no

## Objective

Operator-facing failures currently surface as permanent inline error blocks
that never clear and never reach the notification ledger. Example (live,
2026-08-11): a refused project deletion renders
`project deletion refused: retained resources=1, tasks=6, ...` inline in
the project rail indefinitely. These failures should become notification
records — toasted when they happen, archived for later inspection — and
the permanent inline blocks removed.

## Governing Refs

- `docs/contracts/032-longhorn-desktop-systems-integration-contract.md` —
  consumer boundary; the desktop notification authority is
  `nucleus:desktop-notifications`; longhorn owns the retained ledger
- `longhorn/docs/contracts/016-notification-ledger-and-projection.md` —
  ledger authority and projection rules
- `apps/desktop/src/lib/ProjectRail.svelte:250,325,338,355,369` — the
  `mutationFailure` / `failure` / `threadFailure` inline blocks
- `apps/desktop/src/lib/AgentChatPanel.svelte` — `chat-error` blocks (turn
  failure, general failure) — classify before converting
- Cards 042-044 (same directory) — the ledger/projector/presentation work
  that built the current stack

## Environment Notes

- Same poodle bun-link setup as card 096 if desktop sources are touched
  (see that card's Environment Notes).
- The routing decision may land server-side (nucleus-server raises a
  notification record when refusing an operator command) or renderer-side
  (an admission route for renderer-originated records, if one exists).
  Determine which the contracts admit BEFORE writing code.

## Worker Rules

- Execute the card exactly; no planning authority; no sub-agents.
- Do NOT touch roadmap/milestone/card/dispatch status files — deliverables +
  batch log only.
- Longhorn and poodle sources are read-only.
- Commit on branch `thread/097-failure-notification-routing` and push with
  `git push -u origin thread/097-failure-notification-routing`; no merge.

## Scope

1. **Routing decision first.** Establish from contracts 032 (+ longhorn
   016) where operator-facing command refusals become notification records.
   If the server already has an emission point for refused commands, use
   it. If no admitted route exists for this class of record, that is a
   stop condition (it means contract/design work, not a quick patch).
2. **Convert the project-command refusal path** (the screenshot case):
   refused project deletion/other rail mutations become warning
   notifications with the refusal reason; the permanent inline
   `rail-message-error` blocks for these paths are removed. Transient
   inline affordances that are genuinely contextual (e.g. form validation
   tied to an open editor) may stay — justify each in the log.
3. **Catalog the rest.** Sweep the other permanent inline error blocks
   (`AgentChatPanel` chat-error, settings pages, editor, memory/tasks
   panels) and record per-site disposition in the batch log: converted,
   intentionally inline (why), or needs its own card (why). Convert only
   the clear cases in this card.
4. Fixtures/tests for the converted paths; batch log
   `docs/logs/2026-08-11-failure-notification-routing.md`.

Out of scope: the MessageCenter/Toast presentation (card 096), longhorn or
poodle sources, notification severity taxonomy redesign.

## Acceptance

- [x] refused project commands produce warning notification records with
  the refusal reason (toastable + archivable); inline permanent blocks for
  those paths removed
- [x] routing decision documented with contract citations
- [x] per-site disposition catalog for the remaining inline error blocks
- [x] fixtures + relevant suites pass (`effigy desktop:test`, plus server
  tests if the server emits the records); batch log pushed

## Closeout

Merged to main as `ee51da81` (worker commit `12f14670`). Two flash stream
stalls and two poisoned-session resume failures on Luna; completed on a
fresh Luna-high session (the `-c` resume state was the failure mode, not
the providers — both probed healthy). Routing per contract 032: the Tauri
host observes rejected project command receipts at `submit_control_envelope`
and publishes warning records into `nucleus:desktop-notifications`; the
renderer never calls `Add`. Refusal reason and project scope preserved;
no action reference (retry is not yet an allowlisted notification action).
The disposition catalog intentionally left agent-chat, editor, settings,
memory/tasks, and panel-transport failures inline with their local
recovery affordances; native-island/review/forge/terminal failure classes
are flagged as their own future card.

## Evidence

- Batch log with the routing decision, citations, commands + exit states,
  and the disposition catalog.

## Stop Conditions

- No contract-admitted route exists for operator-facing failure records →
  stop with citations; this becomes a contract card
- Conversion would drop operator-critical context the UI cannot recover
  (e.g. a blocking refusal reason with no archive link) → stop and report
- The sweep reveals failures that are not command refusals at all (e.g.
  transport failures) needing a different admission class → convert the
  clear cases, stop on the rest with a proposed split
