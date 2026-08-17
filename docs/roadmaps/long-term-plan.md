# Long Term Plan

Status: active
Owner: Tom
Updated: 2026-08-17

## Purpose

Provide a stable high-level runway so Nucleus does not keep advancing by small
ad hoc batch cards alone.

Batch cards execute inside an approved generation theme. This plan governs
generation transitions and strategic horizons.

## Planning Rules

- Work in generations with clear themes.
- Keep batch cards as execution aids, not the planning source of truth.
- Do not open more implementation lanes until the current phase goal is
  explicit.
- Prefer phase closeouts over micro-card churn.
- Promote durable findings into architecture and contracts before
  implementation depends on them.
- Keep T3 Code as a specimen, not a template to clone blindly.

## Closed Generations

| Generation | Theme | Result |
| --- | --- | --- |
| `g01` | Foundation, harness research, runtime boundaries, proof diagnostics | closed |
| `g02` | Orchestration spine, Codex runtime, task-backed work, SCM record lanes | closed |
| `g03` | Effect-gated SCM execution, provider reads, planning projection, memory | closed |
| `g04` | Product workflow vertical slice, editor, review, resources, panels | closed |

See `generation-index.md` for the canonical generation table.

## Active Generation: g05 Product Consolidation

Goal: turn proven product features into one coherent application from the shell
inward.

Current result:

- project-scoped workspace composition and Agent Chat-first defaults
- Swallowtail application-scale proof and portable activity adoption
- Longhorn settings, commands, operations, notifications, backup and restore
- shell context, editor or diff or rework cohesion, terminal and browser
  cohesion, memory and provider cohesion, accessibility and failure cohesion
- plan-decision Agent Chat with native acceptance
- agent orchestration phases 1-3 merged; operator live checkpoint pending

Remaining g05 gates:

- operator checkpoint: designate an orchestrator, delegate a real run, review
  delivery
- real forge provider routes for orchestrated delivery
- conditional-paused secondary-window and remote-transport lanes

Canonical refs:

- `g05/README.md`
- `research/translation-memos/agent-orchestration-lane.md`
- `roadmaps/README.md`

## Horizon Model

### Horizon 1 — Orchestration Proof And Forge Reality (`g06` proposed)

Outcome: orchestrated worker runs are trustworthy in daily use, not only as
merged server and desktop surfaces.

Depends on:

- operator live checkpoint for designation, delegation, delivery, and review
- contract `033` promotion after checkpoint evidence
- provider `027` lane for real forge routes used by delivery
- optional phase-4 steering (`message_run`) only if operator selects it

Unlocks:

- multi-worker, multi-provider orchestration without manual playbook glue
- real PR delivery instead of test-double forge routes

Deliberately excludes:

- agent-initiated merge authority
- provider-native child steering before evidence
- broad automation outside orchestrated runs

Rollover trigger: operator checkpoint passes and forge reality is explicit, or
orchestration lane stalls on missing provider authority.

### Horizon 2 — Workflow Depth And Deferred Returns (`g07` proposed)

Outcome: the visible project, task, agent, planning, and memory workflow feels
complete enough to return deferred backend lanes.

Candidate returns:

- planning import active apply
- accepted-memory active apply
- selected-task delegation scheduling
- secondary-window transfer
- production remote transport

Depends on:

- a visible product workflow that needs each deferred lane
- fresh roadmap compilation before resuming any deferred card

Deliberately excludes:

- resuming deferred lanes because they are already specified
- panel or UI sprawl ahead of workflow proof

Rollover trigger: one deferred lane proves product need and passes a fresh
roadmap gate.

### Horizon 3 — Platform Hardening And Multi-Host Maturity (`g08` proposed)

Outcome: Nucleus is usable for sustained real projects across hosts and clients.

Work bands:

- steward native harness maturity
- client protocol and multi-host transport beyond local proof
- observability and diagnostics contract
- release posture, migrations, backups, and repair at product scale
- code-health rebaseline when touched, not as a standalone product lane

Depends on:

- coherent product workflow from horizons 1 and 2
- explicit contracts for remote pairing, diagnostics, and release posture

Deliberately excludes:

- pretending Tauri or one desktop session is the authority surface
- provider flattening or hidden automation

Rollover trigger: product workflow proof is stable and platform contracts are
promoted.

## Open Operator Decisions

- Run the orchestration operator checkpoint now or defer until forge provider
  routes land?
- Promote phase-4 worker steering (`message_run`) in this generation or keep it
  undesigned until live orchestration proves the need?
- Which deferred lane should return first once orchestration proof closes?

## Promotion Map

| Outcome | Destination |
| --- | --- |
| Strategic horizons and generation themes | this file, `generation-index.md` |
| Orchestration lane architecture and phase model | `research/translation-memos/agent-orchestration-lane.md` |
| Durable orchestration authority | `contracts/033-orchestration-runs-and-delegation-authority-contract.md` |
| Time-ordered g06 milestones | future `roadmaps/g06/README.md` after operator checkpoint |
| Refresh and atlas evidence | `logs/2026-08-17-northstar-refresh-and-atlas.md` |

## Historical Phase Map

The pre-2026-06 phase list remains useful as background for closed work, but it
is no longer the live planning authority. Use generation READMEs and batch-card
closeouts for execution history instead of this file's older phase numbering.
