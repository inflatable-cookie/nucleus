# 099 Operator-Dispatched Runs

Status: planned
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1)
Depends on: 098 (run registry)
Auto-start next card: no

## Objective

Let the operator dispatch a run from the desktop: create a worktree for the
project, start a worker conversation/operation bound to the run record with
the objective as its brief, and track the run through the registry. This is
the managed-worktree runner — immediately useful with no orchestrator agent
involved.

## Governing Refs

- Contract 033 (draft) — Worker Operation Rule: a run is an ordinary
  operation on its own worktree; the objective is the brief
- Translation memo decision (2026-08-13): fresh playbook-shaped briefs
- Cards 011-013 lineage — working copy observation, staging, commit control
- The operator's worker-orchestration playbook — the manual pattern this
  automates (worktree per run, objective-shaped prompt, closeout expected)

## Scope (planned)

- Server: run dispatch command — create worktree
  (`<repo>-wt/<run-slug>` per the playbook pattern), create the worker
  conversation bound to that working directory, seed the brief, start the
  operation; bind operation/conversation ids into the run record;
  transition `proposed → dispatched → running` from observed operation
  truth (not timers).
- Desktop: a dispatch affordance from the project (objective form: scope,
  acceptance, stop conditions, provider instance, model, budget).
- Brief template: the playbook card shape (objective, scope, acceptance,
  stop conditions, worker rules) rendered into the worker's first message.
- Run terminal truth: operation completion/failure transitions the run
  (`failed` on operation failure with the failure receipt).

Out of scope: the fleet panel (100), delivery pipeline (101), orchestrator
designation or delegation tools, steering.

## Acceptance (planned)

- [ ] operator can dispatch a run; worktree + worker operation start and
  bind to the run record
- [ ] run state tracks observed operation truth; failures transition to
  `failed` with receipts
- [ ] the worker conversation opens as an ordinary interactable thread
- [ ] fixtures + suites green; batch log

## Stop Conditions

- Worktree creation needs policy authority beyond the current command
  surface → stop with citations
- Binding a conversation to a non-primary working directory breaks an
  existing contract assumption → stop and report
