# 099 Operator-Dispatched Runs

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1)
Depends on: 098 (run registry, merged `94028b31`); 105 (worktree-creation
  authority, merged `d85adc4d`)
Auto-start next card: no

## Authority Gate (resolved 2026-08-13)

The first dispatch stopped on the worktree-creation authority gate (stop
log `docs/logs/2026-08-13-operator-dispatched-runs.md`). Card 105 wired the
chain: contracts 007/011 now admit exactly isolated worktree creation for a
dispatched run through `provider_git_branch_worktree_runner_authority`
(operator-confirmed intent per dispatch via
`ServerCommandKind::GitBranchWorktreeRunner`, admitted handoff, approved
target refs, `ReadyForRunner`, bounded spawn, receipts), and contract 033
carries the Run Worktree Authority Rule. Dispatch must drive that chain —
confirmation command first, gated execution second — never a bare spawn.
The operator-confirmation step is a deliberate UX act: surface it in the
dispatch dialog as the explicit confirmation, not a nag.

## Implementation Map (traced 2026-08-13, orchestrator takeover)

The composition path is verified against source; execute it, don't
re-derive it:

- **Worker cwd**: `AgentSessionStartRequest.working_directory`
  (`local_codex_chat/runtime.rs:106`) is fed by
  `resolve_chat_working_context` (`local_codex_chat/routing.rs:31`), which
  resolves a **project resource target** root. So a run's worker runs
  against a worktree by registering the worktree as a project resource —
  no new cwd plumbing.
- **Resource registration**: project resource mutation machinery exists —
  `ProjectResourceMutationCandidate` / kinds `FilesystemFolder` /
  `GitRepository` (`control_envelope_dto/projects.rs`,
  `project_resource_control`). Register the worktree as a `GitRepository`
  resource.
- **Git execution**: no `git worktree add` exists today (the
  `provider_git_branch_worktree_runner_authority` modules are authority
  records only). Follow the `Command::new("git")` + `--no-optional-locks`
  pattern in
  `provider_git_read_only_runner/working_copy/mutation.rs:124`. Worktree
  path convention: sibling `<repo>-wt/<run-slug>` per the operator
  playbook; branch `run/<slug>`.
- **Run transitions**: propose → dispatch (binds `operation_id` +
  `conversation_id`) → mark-running via
  `EngineRunCommandService`
  (`nucleus-engine/src/run_commands/service.rs`); server composition in
  `request_handler/run_commands.rs` with fixtures in the same file
  (`handler()` test support at :341).
- **Conversation creation**: implicit — `send_agent_chat_message` with a
  fresh conversation id + the worktree resource id starts the worker
  conversation and seeds the brief as the first message. Dispatch creates
  the conversation id deterministically (`conversation:run:<run_id>`);
  `operation_id` binds when the first turn actually starts.
- **Module ratchet**: no new top-level server modules (ceiling 323,
  `crates/nucleus-server/tests/module_ratchet.rs`). Grow
  `request_handler/run_commands.rs` or the engine.
- **Open wiring decision**: `mark-running`/`fail` must come from observed
  operation truth — the chat runtime's activity/session events need a hook
  into run transitions. Locate the turn-start/terminal emission point in
  `local_codex_chat/turn.rs` and wire the transition there, not on timers.

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
