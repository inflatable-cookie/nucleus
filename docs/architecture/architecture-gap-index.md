# Architecture Gap Index

Status: draft
Owner: Tom
Updated: 2026-06-23

## Purpose

Track architecture gaps found during the stocktake and T3 Code comparison.

This is the decision queue before more implementation. It is not a batch-card
list.

## Blocking Gaps

### Orchestration Spine

Current state:

- project and task state are record-oriented
- command evidence exists
- runtime readiness exists
- event-sourced orchestration is selected in
  `docs/contracts/018-orchestration-contract.md`

Why it matters:

- harness runtimes, tasks, threads, checkpoints, SCM operations, and steward
  actions need one shared timeline model
- without it, provider work will accrete around ad hoc mutations

Decision:

- use event-sourced orchestration for durable work crossing tasks, sessions,
  runtime receipts, checkpoints, SCM operations, hosts, and clients

Likely documents:

- `docs/contracts/018-orchestration-contract.md`
- update `007-server-boundary-contract.md`
- update `008-storage-state-persistence-contract.md`
- update `010-agent-session-lifecycle-contract.md`

### Conversation Timeline

Current state:

- agent sessions are planned
- task records are planned and partly implemented
- canonical timeline entities are now drafted in
  `docs/contracts/019-conversation-timeline-contract.md`

Why it matters:

- provider adapters cannot be made stable without identity rules for timeline
  entities
- task delegation needs a durable unit of work that can survive provider
  restart, host restart, and client switch

Decision needed:

- define canonical timeline entities and how provider-specific messages map to
  them

Likely documents:

- `docs/contracts/019-conversation-timeline-contract.md`
- update `002-harness-adapter-contract.md`
- update `005-task-contract.md`
- update `010-agent-session-lifecycle-contract.md`

### Runtime Receipts And Progress Events

Current state:

- local command evidence is sanitized and queryable
- runtime effect vocabulary exists
- runtime receipt and progress event rules are now drafted in
  `docs/contracts/020-runtime-receipt-contract.md`

Why it matters:

- long-running work needs durable receipts for what was requested, what ran,
  what changed, what failed, and what can be retried
- clients need progress without becoming state authorities

Decision needed:

- define receipt classes for commands, harness events, SCM operations,
  research runs, steward actions, and tool calls

Likely documents:

- `docs/contracts/020-runtime-receipt-contract.md`
- update server boundary and storage contracts

### Checkpoints And Diffs

Current state:

- SCM/worktree ideas are planned
- command evidence exists
- checkpoint and diff ownership is now drafted in
  `docs/contracts/021-checkpoint-diff-contract.md`

Why it matters:

- users need to review, revert, merge, or publish work at coherent boundaries
- agent turns and SCM changes need a shared proof model

Decision needed:

- decide whether checkpoints belong to turns, tasks, sessions, branches,
  snapshots, or a separate change-set entity

Likely documents:

- `docs/contracts/021-checkpoint-diff-contract.md`
- update SCM/forge contract
- update task contract

### SCM Driver And Forge Provider Split

Current state:

- SCM/forge sync contract is adapter-based
- Git is not assumed as the only possible SCM
- a metadata-only SCM/forge driver registry exists
- static SCM, forge, and observation-source trait skeletons exist
- runtime effect vocabulary and state types exist
- no provider command execution, network client, scheduler, replay, or
  credential integration exists

Why it matters:

- Git, Convergence, and future SCMs will not share exact commit vocabulary
- GitHub/GitLab/Bitbucket-style provider workflows are not the same as SCM
  storage workflows

Decision:

- separate SCM driver capability model from forge/source-control provider
  discovery, auth, and publication workflows

Likely documents:

- update `011-scm-forge-sync-contract.md`
- add capability terms for snapshots, commits, change requests, publication,
  review, merge, and repair

Remaining gap:

- turn the current type-only and metadata-only surfaces into provider-specific
  runtime adapters only after the next health gate clears oversized module
  pressure

### Host Authority And Remote Auth

Current state:

- engine-first host authority is documented
- local embedded/sidecar/remote host forms are planned
- no pairing/session/revocation protocol exists

Why it matters:

- multi-host UI requires explicit trust and authority maps
- remote authoritative hosts need different safety rules from local proxy hosts

Decision needed:

- define pairing, session token, revocation, host capability advertisement,
  and authority-map update rules

Likely documents:

- update `017-engine-host-authority-contract.md`
- split remote auth out of `007-server-boundary-contract.md`

### Tool Broker, Preview, And MCP

Current state:

- browser panels are planned
- bridged and native harnesses are planned
- no first-class tool broker contract exists

Why it matters:

- provider sessions need access to terminals, files, browser previews, MCP
  servers, Effigy, and local tools through controlled boundaries
- native and bridged harnesses should share tool routing where possible

Decision needed:

- define tool broker authority, permission prompts, credential scope, and
  session binding

Likely documents:

- new tool broker contract
- update harness adapter, native harness, Effigy integration, and server
  boundary contracts

### Observability

Current state:

- diagnostics panels exist
- command/readiness evidence exists
- no observability contract exists

Why it matters:

- long-running hosts and multi-client sessions need traceability
- without budgets and metrics, performance problems will hide inside provider
  runtimes and storage projections

Decision needed:

- define logs, traces, metrics, health checks, resource monitors, and support
  bundle boundaries

Likely documents:

- new observability contract
- update runtime readiness docs

### Provider Live-Read Product Boundary

Current state:

- fixture-backed provider live-read admission is complete
- the first approved manual GitHub CLI read was promoted as selected-field
  evidence
- approved smoke evidence can be persisted, replayed locally, queried, and
  surfaced as a provider-readiness source count
- status/check refresh is selected and modeled as the second stopped live-read
  family
- no automatic provider execution, provider write, credential material storage,
  raw payload retention, task mutation, callback, interruption, or recovery
  execution has been granted

Why it matters:

- the boundary now proves the shape of live-read evidence without proving that
  more provider work is the highest-value next product lane
- a live provider read executor must not become a general forge client by
  momentum
- the approved repository-metadata and status/check smokes are enough evidence
  to pause provider execution and harden server/client workflow coherence

Decision:

- pause provider live-read execution work.
- select server/client workflow hardening around existing read models before
  adding more provider execution.

Likely documents:

- `docs/roadmaps/g03/107-provider-live-read-reassessment.md`
- `docs/roadmaps/g03/108-server-client-workflow-hardening.md`

## Non-Blocking Gaps

- plugin system runtime split between Rust and TypeScript
- VS Code theme and language-service boundary for editor panels
- deep research execution topology
- steward/local-model backend selection
- Effigy tool-surface shape inside native harnesses
- visible provider-readiness UI beyond proof surfaces
- status/check live provider execution beyond stopped records

These should wait until the orchestration and host-authority decisions are
settled.
