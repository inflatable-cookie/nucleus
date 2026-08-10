# 092 Subagent Rendering Survey

Status: completed
Owner: Tom
Created: 2026-08-10
Milestone: none (research surface)
Depends on: none
Branch: `thread/092-subagent-rendering-survey`

## Worker Rules

- You are an execution worker. Execute this card exactly — scope, steps,
  acceptance criteria, stop conditions. No planning authority.
- Do NOT spawn sub-agents or parallel research tasks; read sources directly.
- Do NOT touch roadmap, milestone, card, or dispatch status files. Write
  only: the survey deliverable and your batch log section inside it.
- Cite every claim with a URL or a repo file path. No uncited assertions.
  No recommendations or rankings — the planner decides from the tables.
- Commit on the branch above and push with
  `git push -u origin thread/092-subagent-rendering-survey`. Do not merge.

## Governing Refs

- `docs/research/README.md` and `docs/research/source-hubs/README.md` —
  follow the existing hub/dossier shape
- `docs/research/source-hubs/harness-communications.md` — sibling survey for
  tone and structure
- Swallowtail contract 045
  (`/Users/tom/Dev/projects/swallowtail/docs/contracts/045-subagent-topology-observation-and-control.md`) —
  the portable subagent model the eventual design must map onto (observation
  only: snapshots, statuses, parentage, directories)

## Scope

One new research hub: `docs/research/source-hubs/harness-subagent-rendering.md`
— a cross-product survey of how agent harness apps render sub-agent /
child-agent activity to the operator. Nothing else changes.

Out of scope: any code, any contract or spec, any recommendation or design
proposal, any change outside the one new file.

## Required Products (survey each)

1. Claude Code (CLI and desktop app) — Task tool / sub-agent display
2. OpenAI Codex (CLI TUI and desktop app; multi-agent collaboration display)
3. Cursor (agent UI, including background/parallel agents)
4. Zed editor (agent panel)
5. OpenCode (TUI sub-agent rendering)
6. Kimi Code CLI
7. t3code — read the local checkout at `/Users/tom/Dev/projects/nucleus/external/t3code`
   directly; it is open source, so cite file paths for its sub-agent/thread UI

Optional if evidence is easy: Amp, Goose, JetBrains Junie, Aider, Windsurf.

## Evidence To Capture Per Product

- how a sub-agent first appears when spawned (inline row, notice, new thread,
  panel, nothing)
- in-transcript representation: inline rows, nested/collapsible groups, or a
  separate view
- live progress: whether the child streams activity, and where
- output access: merged inline, expandable detail, or a separate child view
- parallelism: how several concurrent children are shown
- failure and cancellation presentation
- attribution: naming, icons, colour, badges
- sources: URLs for docs/changelog/screenshots/videos; repo paths for t3code

Prefer primary sources (official docs, changelogs, OSS code, recorded demos).
Where only secondary sources exist, mark the row as such.

## Steps

1. Read the governing refs for shape and constraints.
2. Survey the required products; draft the hub with one section per product
   and a closing comparison table (rows = the evidence items above).
3. Note explicitly where evidence could not be found (absence is data).
4. Commit and push the branch.

## Acceptance Criteria

- The hub file exists, follows the source-hub shape, and covers all seven
  required products
- Every product section cites at least one primary source (or says none
  found, marked)
- The comparison table is complete across the evidence items
- No recommendations, no design proposals, no uncited claims

## Evidence

- The hub file itself, ending with a batch-log section: what you searched,
  what you could not find, and anything unverifiable.

## Stop Conditions

- No web access from this environment → stop, record what you tried, and
  survey t3code from the local checkout only
- A product's rendering cannot be evidenced from any source → mark the row
  "no public evidence found", do not guess
- Anything in the governing refs contradicts this card → stop with citations

## Closeout

Merged `b48d076a`. Survey covers all seven required products plus four
optional, cited per claim, absences recorded as data, comparison table
complete, no recommendations. Two provider-stream stalls (grok-4.5-medium
twice, flash once) were handled by resume; the flash resume completed the
card. Third-model completion noted for the routing table.
