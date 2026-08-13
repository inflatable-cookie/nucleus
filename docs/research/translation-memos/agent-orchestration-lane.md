# Agent Orchestration Lane

Status: active
Owner: Tom
Updated: 2026-08-13

## Purpose

Translate the managed-delegation evidence in
`../source-hubs/harness-agent-orchestration.md` into a nucleus architecture
position and a contract/lane proposal. The operator goal: designate an agent
as a project orchestrator; the orchestrator delegates work to worker agents —
potentially from other providers — on separate worktrees; runs are visible,
interactable threads; completed runs are summarised, committed, pushed, and
delivered for review and merge.

## The Load-Bearing Distinction

Two different things get called "subagents":

- **Provider-orchestrated children**: the provider spawns and owns child
  threads inside one operation (Codex collab, ACP `kind: "subagent"` tool
  calls). Swallowtail contract 045 governs their observation; card 093
  renders them. The harness is a witness.
- **Harness-orchestrated workers**: the harness itself starts an ordinary
  provider session against a chosen provider, model, and working directory.
  This lane is the second kind. A worker run is a *first-class operation
  bound to a worktree and a run record*, not a child thread.

This distinction is what makes the lane cheap to start: workers reuse the
entire existing per-operation stack — transcript persistence, question
rendezvous, plan decisions, subagent groups, activity projection,
reconciliation — because they are ordinary operations. What is new is the
layer that owns their lifecycle.

## What Already Exists (do not rebuild)

| Need | Existing asset |
| --- | --- |
| Worker session against any provider | swallowtail provider-wide facade; configured provider instances (g03/024) |
| Worker liveness and terminal truth | swallowtail reconciliation + detachment (g03/026-038) |
| Worker thread rendering + interaction | nucleus agent chat panel, questions, plan decisions, subagent groups (093) |
| Working copy observation, staging, commit | cards 011-013 |
| Review workflow (diff → editor, rework handoff) | cards 063-066 |
| Command admission and policy | `nucleus-command-policy`; contracts 032 + longhorn command contracts |
| Host tools offered to an agent session | Codex route already carries consumer-declared dynamic tools: nucleus `ToolDeclaration`s flow through swallowtail `dynamicTools` (`nucleus-agent-adapters/src/swallowtail_codex/tools.rs`, `swallowtail-adapter-codex/src/session_input.rs`) — this is how `task_ledger` works today |
| Durable orchestration spine | contract 018 (event-sourced commands, events, projections, receipts) |
| Operator notification of run events | notification ledger (042-044) + message centre (096-097) |
| Control-role framework for children | swallowtail 045 §Operator Inspection And Control |
| Delegation vocabulary precedent | ACP subagent discussion; Codex collab tools (spawnAgent, sendInput, wait, closeAgent) |
| The working pattern itself | the operator's worker-orchestration playbook (cards, worktrees, dispatch ledger, closeout) — this lane productizes it |

## Architecture Position

1. **The run record is the aggregate.** A run binds: objective (card-shaped:
   scope, acceptance, stop conditions), worktree, provider instance + model,
   operation/conversation id, lifecycle state
   (`proposed → dispatched → running → delivered → accepted | rejected |
   failed | cancelled`), and a closeout (summary, evidence, diff
   reference). It lives in the contract-018 spine: commands mutate it,
   events record it, projections feed the UI, receipts prove side effects.
   Playbook shape is deliberate — structured completion is what lets an
   orchestrator agent (not just a human) review a run.
2. **The orchestrator is a designated provider instance, not a new runtime.**
   Designation is operator-granted per project and carries a grant envelope:
   allowed worker providers/models, concurrent-run budget, per-run token/time
   budget, allowed delegation actions, and whether steering workers is
   permitted. Deny-by-default, per the cross-product permission consensus.
3. **Delegation tools are harness tools offered to the orchestrator's
   session.** The stable verb set from the evidence: `delegate` (objective,
   provider, model, budget; returns run id), `run_status`, `message_run`,
   `cancel_run`, `accept_delivery` / `reject_delivery`. The Codex route
   already carries consumer-declared dynamic tools end to end (the
   `task_ledger` path), so nucleus implements the verbs as server-side
   tools admitted only to designated orchestrator sessions; the swallowtail
   work is per-route qualification of the dynamic-tool channel (Codex has
   it; ACP routes need evidence) plus admission rules, not a new surface
   from scratch.
4. **Workers are ordinary operations on worktrees.** Spawning = create
   worktree + start a conversation/operation with the run's objective as the
   brief. The operator can open any run as a thread and interact directly —
   that already works once the run is a conversation. Orchestrator-to-worker
   steering is nucleus-server posting into the worker conversation (clearly
   attributed as the orchestrator, not the operator), which needs no
   provider child-control at all. Provider-native child control (045 bound
   roles) stays out of scope until a provider route justifies it.
5. **Delivery is a pipeline, not an event.** `delivered` means: worker
   finished, closeout written, validation run, branch committed and pushed,
   PR opened (or delivery packet prepared when no forge is configured).
   Acceptance is a separate act. Default posture: **the orchestrator
   prepares and reviews, the operator merges.** Agent-initiated merge/push
   to shared remotes is a later, separately-granted capability — the
   cross-product evidence keeps merge human even where review is automated.
6. **Reconciliation owns the orphans.** Runs are operations, so crash,
   detach, and external-deletion truth comes from the existing
   reconciliation generation; the fleet projection must show degraded truth
   honestly (a run whose operation died is `failed`, not silently absent).

## Contract Impact

New work, in dependency order:

- **Nucleus contract (new): Orchestration Runs And Delegation Authority.**
  Run aggregate states and transitions; grant envelope contents and
  enforcement points; operator designation of orchestrators; the
  delivery/acceptance split; merge authority default; budget exhaustion
  behavior; attribution rules (orchestrator messages in worker threads are
  labeled, never impersonate the operator); audit requirements (every
  delegation decision is a receipt).
- **Swallowtail contract (new or 045-adjacent): Host-Tool Surface For
  Managed Sessions.** Narrower than first scoped: the Codex dynamic-tool
  channel exists and is proven (`task_ledger`). The contract work is
  admission and qualification — which routes may carry consumer-declared
  tools, per-route capability declaration, bounded tool counts and schema
  sizes (already enforced for Codex), and pre-dispatch rejection where a
  route cannot carry them. 045's bound-role framework is the template.
- **Amendments**: nucleus 032 (consumer boundary — orchestration runs join
  the adopted-systems list); nucleus 018 if the run aggregate needs envelope
  changes (expected: none, it composes); swallowtail 045 only if a provider
  route later exposes real child steering.

## Lane Proposal

Sequenced so each phase is independently useful:

1. **Run registry + fleet projection** (nucleus server + desktop): the run
   aggregate, persistence, fleet panel (status board), run-as-thread
   navigation. Operator-dispatched runs only — no orchestrator agent yet.
   This is immediately useful as a managed-worktree runner.
2. **Delivery pipeline**: closeout capture, validation hook, commit/push/PR
   preparation, review surface (reuse the 063-066 review workflow),
   operator accept/merge.
3. **Orchestrator designation + delegation tools**: grant envelopes, the
   host-tool surface in swallowtail, delegation verbs against the registry,
   orchestrator review of deliveries. The feature as titled lands here.
4. **Steering and lateral patterns**: `message_run`, operator-in-worker
   interaction polish, budgets enforcement, and — only if evidence demands —
   provider-native child control roles.

Poodle components, when the UI lands: a run/fleet card (status, provider,
budget burn, closeout link) and a delivery-review surface (summary + diff +
accept/reject). Everything else reuses AgentTranscript, AgentSubagent,
AgentQuestion, MessageCenter.

## Open Questions For The Operator

- Merge authority: is operator-merge the permanent posture, or a starting
  gate with agent-merge as a later grant? (Proposal assumes the latter,
  gated per project.)
- Worker context: fresh brief per run (cheap, lossy) versus fork/inherit
  (ACP fork RFD territory, provider-dependent)? Proposal starts with fresh
  briefs shaped like playbook cards.
- Does the orchestrator run as a special mode of the existing agent chat
  panel, or a distinct surface? Proposal: a mode — the panel already
  handles questions, plans, and subagents; orchestration adds its tools and
  the fleet affordance.
- Forge integration: PRs need a forge remote; what is the no-forge delivery
  packet shape (branch + summary only)?

## Validation Needs

- A two-worker proof against real providers before phase 3 widens: one
  Codex worker + one ACP-route worker, same registry, both delivered and
  reviewed.
- Budget enforcement must fail closed and visibly; a run that hits its
  budget is `failed` with a receipt, never silently throttled.
