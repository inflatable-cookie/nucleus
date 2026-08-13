# Operator-Dispatched Runs — STOPPED at dispatch authority gate

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/099-operator-dispatched-runs.md`
Branch: `thread/099-operator-dispatched-runs`

## Outcome

Card stopped at the dispatch design review. Stop condition 1 fires: **worktree
creation needs policy authority beyond the current command surface.** The run
dispatch command cannot create `<repo>-wt/<run-slug>` worktrees without
violating the repo's realized authority boundaries and bypassing the dedicated
branch/worktree runner authority chain that exists specifically to gate that
effect. No code was written. Citations below.

## Findings

### 1. Worktree creation is excluded from the current execution boundary

- Contract 007 (active), Local Command Runner Implementation Contract: the
  first runner must reject `SCM mutation` and `worktree mutation`
  (`docs/contracts/007-server-boundary-contract.md:1728-1729`); the first
  process supervisor must not support them (`:1822-1823`); host process
  spawning remains blocked until structured invocation, supervision readiness,
  and sandbox/artifact policy prove the constraints
  (`:1775`, `:1937-1940`).
- Contract 011 (active): the first implementation "must set provider mutation
  to false. It must not checkout, switch, branch, create worktrees, stage,
  commit, snap, publish, push..." (`docs/contracts/011-scm-forge-sync-contract.md:599-601`);
  the realized working-session surface "does not create branches, create
  worktrees, switch refs, delete directories, merge, publish, or mutate
  provider state" (`:1067-1068`).
- The whole branch/worktree lineage kept the effect false by design: g01 card
  029, g02 cards 041/063/090/188, g03 cards 002/003/004 all record
  "create worktrees: false / stopped / gated". Contract 021's realized
  boundary likewise "does not ... create branches or worktrees"
  (`docs/contracts/021-checkpoint-diff-contract.md:82-84`).

### 2. The repo has a declared authority gate for worktree creation, and it is stopped-by-default

`nucleus-server/src/provider_git_branch_worktree_runner_authority/` is the
repo's declared gate for branch/worktree runner invocation: `ReadyForRunner`
requires admitted execution handoffs, an
`GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` carrying
`allow_isolated_worktree_creation`, and policy-approved target refs
(`.../types.rs`; blocker `IsolatedWorktreeCreationNotConfirmed`). The chain is
pure record-building: every record persists `shell_execution_performed: false`
and `worktree_created: false`, no command or CLI ever feeds it an operator
effect intent (only its own unit tests do), and no runner that executes Git
exists. Architecture audits state it verbatim:

- "Git branch/worktree runner authority records that admit future runner
  invocation only from admitted handoff records, explicit operator effect
  intent, and policy-approved branch/worktree target refs" and "the authority
  records keep shell execution false"
  (`docs/architecture/implementation-gap-index.md:765-770`).
- The runner command adapter "builds structured argv for primary-tree branch
  checkout and isolated-worktree creation ... It does not spawn Git"
  (`:771-775`).
- "Until that lane proves durable authority and preflight, keep checkout,
  worktree creation, commit, push, branch mutation, pull-request creation,
  publish, promote, merge, ... and broad real provider writes gated."
  (`:1471-1474`; same posture in `implementation-audit.md:142-146`).

### 3. The current control command surface has no git mutation commands at all

`ServerCommandKind` is Project / Task / Run / Goal / Workspace / AgentSession /
Steward / MemoryProposalReview / ReadOnlyCommand / ConfigureModelRoute
(`crates/nucleus-server/src/commands.rs:28-41`); `ReadOnlyCommand` is
read-only by construction (`commands.rs:80-91`). The working-copy stage/commit
functions (`provider_git_read_only_runner::working_copy`, cards 011-013
lineage) run `git add`/`git commit` in tests but have no request-handler
callers — they are not on the command surface either. A dispatch command that
executes `git worktree add` would be the first git mutation on the control
surface, and the one effect the repo explicitly routed through a
stopped-by-default authority chain.

### 4. Stop condition 2 evaluated: does not fire

Contract 011 lists per-thread worktree as a supported work-session isolation
mode (`011-scm-forge-sync-contract.md:996-998`), so binding a conversation to
a worktree directory is not a contract violation in principle. Moot in
practice: the worktree is the prerequisite, and the chat stack resolves
working directories only from project resources
(`resolve_chat_working_context` -> `resolve_optional_project_resource_target`,
`nucleus-server/src/local_codex_chat/routing.rs`), with
`StoredChatSession.resource_id` naming a project resource or the
`resource:none` sentinel. Binding to a non-resource worktree path would need
auto-attaching the worktree as a project resource or a path override in the
chat stack — both new behaviors beyond this card's described scope, and both
downstream of the worktree-creation gate.

## What Was Checked

- Run aggregate from card 098 is ready: `EngineRunStorageRecord` already
  carries `worktree_ref` / `operation_id` / `conversation_id` and the
  `Dispatch` command transitions `proposed -> dispatched` binding those ids
  (`crates/nucleus-engine/src/run_commands/`). The missing piece is purely the
  execution authority to create the worktree and start the operation.
- Conversation machinery (`StoredChatSession`,
  `LocalCodexChatSession::start`, `selected_route`, provider catalogue) can
  start a session on an arbitrary working directory with provider instance +
  model, and a fresh conversation id seeds the brief as the first message —
  no create-conversation command exists; sessions are lazily minted per turn.
- Worker playbook pattern confirmed: `git worktree add ../<repo>-wt/<slug>
  -b thread/<slug>`, worker runs inside, closeout expected
  (`/Users/tom/Dev/docs/worker-orchestration-playbook.md`).

## Not Touched

No roadmap, milestone, card, or dispatch status files; no swallowtail,
longhorn, or poodle sources; no code. Card status stays `dispatched` — the
operator decides the next move.

## Recommended Next Step

Decide the worktree-creation authority question at the policy surface, one of:

1. Route run-dispatch worktree creation through the existing
   `provider_git_branch_worktree_runner_authority` chain: wire an
   operator-confirmation control command that produces a durable
   `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` per dispatch,
   then land the runner execution path the chain was built for (new card,
   with contract updates since 007/011 explicitly exclude worktree mutation
   today).
2. Amend contract 033 (draft) to active with an explicit run-dispatch worktree
   grant and update contract 007/011 realized-boundary text accordingly, then
   re-dispatch 099.
3. Scope 099 down to dispatch-without-isolation: run on the project's existing
   working resource (no new worktree), which keeps the current authority
   surface intact but abandons the playbook's per-run isolation — only viable
   if the operator accepts shared-checkout runs.

## Commands And Exit States

None run — investigation only. No validation commands apply to a stopped card.
