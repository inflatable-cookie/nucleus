# 034 Agent Instruction Surface

Status: active
Owner: Tom
Updated: 2026-08-17

## Scope

Rules for root and nested agent instruction files in this repository.

Northstar greenfield repos use `003-agent-instruction-surface.md`. Nucleus keeps
the existing `003-project-identity-contract.md` and records agent instruction
rules here instead.

## Root Surface Classes

Root `AGENTS.md` should contain only:

- repository identity and scope
- always-loaded boundaries and stop rules
- verified common Effigy commands
- minimal docs authority pointers
- project-specific invariants that apply on most turns
- read-on-demand pointers to contracts, guides, and skills

Do not put batch history, roadmap narration, or procedural workflows in root
`AGENTS.md` when a contract, guide, skill, or canonical doc owns them.

## Claude Bridge

Root `CLAUDE.md` must contain the exact `@AGENTS.md` reference and nothing else
unless a real Claude-only instruction cannot live in `AGENTS.md`.

## Continuation Rule

In a strict Northstar lane, a bare `continue` should be enough.

Treat it as:

- resume from the previous closeout's next move
- re-anchor on the current ready card or explicit stop or reassessment step
- stay inside the bounded lane unless file state requires a stop

Keep the active `## Next Task` pointer only in `docs/roadmaps/README.md`.
Do not duplicate it into README files, contracts, specs, research notes,
architecture docs, batch cards, or other docs front doors.

## Batch Size Rule

Work in complete, meaningful chunks.

- before editing, inspect the current ready card plus nearby planned cards
- plan a multi-card stretch when the cards are small or tightly related
- execute several related cards in one turn when validation can cover them
  together
- avoid one-card turns unless the card is genuinely large, risky, blocked, or
  the operator explicitly asks for a narrow step
- close and advance multiple cards together when they form one coherent lane
- run validation after the full chunk, not after each tiny edit
- if the work starts becoming nitpicky, pause and re-scope around the broader
  lane goal before continuing

## Planning Ambiguity Rule

When planning is needed and the next direction is not settled in the repo's
authority surfaces, stop and ask for operator intent instead of guessing.

## Reporting Rule

For meaningful checkpoint replies:

- lead with what changed
- state current lane state
- mention validation only when it failed or changes confidence
- state the next move

Use glue-light writing. See `docs/policy/internal-writing-style.md`.

## Worker Mode Boundary

Normal-mode agents use the current checkout and follow the task's canonical
docs. Worker mode is active only when an orchestrator-dispatched handoff under
`docs/handoffs/` declares `handoff_mode: worker-pr-loop`,
`worker_mode: implementation`, and `dispatch_authority: orchestrator`. Read
that handoff for its worker execution contract instead of inferring worker mode
from a path, branch, or harness. The operator-facing dispatch path is absolute
and names the owning repo (Poodle for Poodle-planned adoption lanes; Nucleus
for Nucleus-owned lanes). Do not treat a sibling repo's handoff as a relative
file under this checkout.

## Papercuts Loop

During execution, record a small recurring solvable hurdle in `PAPERCUTS.md`
according to `001-working-rules.md`. Do not turn that observation into unplanned
work unless the fix is already in scope.
