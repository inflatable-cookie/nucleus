# 093 Subagent Group Transcript Rendering

Status: completed
Owner: Tom
Created: 2026-08-10
Milestone: none yet (subagent interface lane)
Depends on: poodle g12/023 (`AgentSubagent` component + `subagent-group`
  transcript kind)
Auto-start next card: no

## Objective

Render provider child work as inline subagent groups in the Agent Chat
transcript, replacing per-row attribution with one group per child per turn:
identity + status header, live activity line while running, expandable
detail, and click-through into the child's attributed view.

## Governing Refs

- `docs/research/source-hubs/harness-subagent-rendering.md` — the evidence
  base; the pattern is the OpenCode inline group with child navigation
- `docs/contracts/019-conversation-timeline-contract.md` — Provider Work
  Projection Rule (actor attribution); this card adds the presentation rule
- Swallowtail contract 045 — observation-only; no control affordances
- Poodle contract `poodle/docs/contracts/components/agent-subagent.md` (once
  merged) — the component API

## Environment Notes

- The poodle component merged to poodle main as `bf5dc91f`. The worktree
  parent (`nucleus-wt/`) already symlinks `poodle`, `longhorn`, and
  `swallowtail` to the live sibling checkouts; the file: dependency paths in
  `apps/desktop/package.json` resolve through them.
- Run `bun install` in `apps/desktop` before building or testing so the
  poodle copy includes `AgentSubagent`.
- Read the merged component contract for the exact API:
  `/Users/tom/Dev/projects/poodle/docs/contracts/components/agent-subagent.md`.

## Worker Rules

- Execute the card exactly; no planning authority; no sub-agents.
- Do NOT touch roadmap/milestone/card/dispatch status files — deliverables +
  batch log only.
- Poodle's merged component contract is authoritative for the component API;
  a mismatch is a stop-condition finding with citations.
- Commit on branch `thread/093-subagent-group-transcript` and push with
  `git push -u origin thread/093-subagent-group-transcript`; no merge.

## Scope

- `apps/desktop/src/lib/agentChatTranscript.ts`: group per-turn activities
  by actor; primary work keeps current rendering; each child becomes one
  `subagent-group` item (label from the directory, status from the last
  observed snapshot, activity line from the latest activity's label or
  first content line, detail lines from that child's activity labels).
  Undecided edge: children with no directory entry render as today
  (attributed rows) — never invent identity.
- `apps/desktop/src/lib/AgentChatPanel.svelte`: map `subagent-group` items
  to the poodle component; `onOpenChild` selects that child in the existing
  actor-selection mechanism (the current directory switcher behavior).
- `apps/desktop/src/lib/control/agentChat.ts`: DTO mirrors if needed.
- Transcript fixtures covering: one child group, several children, running
  vs terminal status, unknown status rendered literally, no-directory
  fallback.
- Batch log `docs/logs/2026-08-10-subagent-group-transcript.md`.

Out of scope: server/persistence changes (the directory and activities are
already persisted), the actor-navigation selector, any control affordance,
poodle or swallowtail sources.

## Acceptance

- [x] child activities render as one `subagent-group` per child per turn
- [x] running children show the live activity line; terminal children show
  the summary; unknown stays literal
- [x] `onOpenChild` switches the transcript to the child's attribution and
  back
- [x] fixtures + `effigy desktop:check` + `effigy desktop:test` pass

## Closeout

Merged to main as `7f45481b` (worker commit `55fb5988`). Executed on
`gpt-5.6-luna-high` after two flash stream-stall resumes; the worker's one
stop (Poodle `onOpenChild` forwarding gap) was ruled correct and closed in
poodle before resume. The acceptance line previously blocked by Longhorn
export drift cleared once main fixed the drift (`886a9d07`); post-merge
verification on main checkout with poodle linked to local source:
`bun run check` 0 errors, `bun run test` 69 bun + 23 vitest passed.

## Evidence

- Batch log with commands + exit states and fixture names.

## Stop Conditions

- The merged poodle component API contradicts this card → stop with citations
- Grouping would drop or reorder provider truth (sequence, attribution) →
  stop and report
- Scope pressure toward server or poodle changes → stop and report
