# Harness Agent Orchestration Source Hub

Status: open
Owner: Tom
Updated: 2026-08-13

## Purpose

Collect evidence for how agent harness products support *managed delegation*:
an orchestrator (operator or agent) that dispatches work to worker agents as
foreground, inspectable, steerable sessions with a delivery path back (summary,
commit, PR, review, merge). This is the fleet-level complement to
`harness-subagent-rendering.md`, which covered provider-internal child work.
The distinction that matters here: provider-orchestrated children (Codex
collab, ACP subagent tool calls) versus harness-orchestrated workers (the
product owns the session, workspace, and delivery).

Each section records, where evidence exists: the delegation model, the
authority/permission surface, the fleet UX, the delivery and merge path, and
observed failure modes. Absences are stated, not guessed.

## Sources

- Cursor background agents:
  `https://cursor.com/help/ai-features/background-agents.md`;
  `https://madewithlove.com/blog/using-cursor-background-agents/`
- Cursor Review / merge queue: `https://cursor.com/docs/cursor-review/merge-queue`
- GitHub Copilot coding agent:
  `https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/`;
  `https://code.visualstudio.com/docs/copilot/copilot-coding-agent`
- Copilot Mission Control (GA):
  `https://github.com/orgs/community/discussions/177791`
- Copilot assignment API:
  `https://github.blog/changelog/2025-12-03-assign-issues-to-copilot-using-the-api/`
- Devin advanced capabilities (managed Devins):
  `https://docs.devin.ai/work-with-devin/advanced-capabilities`
- Devin Desktop Agent Command Center / Spaces / ACP:
  `https://vynula.com/windsurf-ai-explained/` (2026-08-02);
  `https://byteiota.com/windsurf-is-now-devin-desktop-what-actually-changed/`
- OpenCode agents: `https://opencode.ai/docs/agents/`
- OpenCode background-delegation plugin request (task_bg, PolicyResolver):
  `https://github.com/Gentleman-Programming/gentle-ai/issues/373`
- OpenCode async delegation request:
  `https://github.com/anomalyco/opencode/issues/5887`
- herdr delegation plugin (delegate/delegate_bg/delegate_status/delegate_close,
  orphan sweep): `https://github.com/EDMND-SRC/herdr-subagents`
- Claude Code subagents / agent teams:
  `https://code.claude.com/docs/en/sub-agents`; Thoughtworks Technology Radar
  vol. 34 (agent teams vs swarms)
- Zed agent profiles and tool permissions:
  `https://zed.dev/docs/ai/agent-panel`;
  `https://zed.dev/docs/ai/agent-settings`;
  `https://github.com/zed-industries/zed/discussions/49590`
- ACP session fork RFD: `https://agentclientprotocol.com/rfds/session-fork`
- ACP subagent tool-kind discussion (childSessionId, availableSubagents,
  delegation policy): `https://github.com/orgs/agentclientprotocol/discussions/690`
- Qwen fork-subagent design (context inheritance, cache cost):
  `https://qwenlm.github.io/qwen-code-docs/en/design/fork-subagent/fork-subagent-design/`
- Qwen ACP subagent observability gap:
  `https://github.com/QwenLM/qwen-code/issues/952`

## Evidence By Product

### 1. GitHub Copilot coding agent + Mission Control

- **Delegation model**: work is assigned, not spawned — a GitHub issue (or
  freeform task) is assigned to Copilot, which works in an ephemeral Actions
  environment and opens a pull request. Assignment API supports target
  repository, base branch, custom instructions, and custom agents.
- **Authority surface**: enterprise governance with audit logging and policy
  controls; steering and collaboration require write access to the
  repository. Read-only contributors cannot use it (no fork-based flow).
- **Fleet UX**: Mission Control is a unified task-management surface across
  github.com, the agents panel, mobile, and CLI; sessions and full reasoning
  logs are visible to anyone with repository access; every commit links back
  to its session log.
- **Delivery path**: agent opens a (draft) PR and requests human review;
  the human merges. "Continue anywhere" hands the session to Codespaces, VS
  Code, or the CLI for human finishing.
- **Failure modes**: permission/token scoping (bot tokens can't reach CI
  templates in other projects); re-requesting bot reviews lacks API support.

### 2. Cursor background agents

- **Delegation model**: agents run in isolated cloud environments, prepare a
  PR in the background, and the operator reviews and tests in one pass.
  Spawnable via API.
- **Authority surface**: API-spawned agents inherit GitHub App installation
  tokens; scope mismatches surface as missing capabilities (e.g. cannot post
  PR comments despite "correct" permissions).
- **Fleet UX**: an agents window lists runs; Cursor Review adds automated
  risk scoring, behavioral evidence (recordings), and review agents ahead of
  human merge.
- **Delivery path**: PR-centric; vendor claims 30-40% of PRs merge without
  human review after automated verification — the aggressive end of the
  merge-gate spectrum.

### 3. Devin (cloud) and Devin Desktop

- **Delegation model**: a coordinator session breaks down large tasks and
  delegates to "managed Devins", each in its own isolated VM. Devin 2.0
  added parallel sessions (ten tickets, ten Devins). The plan is editable
  and approvable before work starts.
- **Fleet UX**: Agent Command Center is a kanban over every local and cloud
  agent session. Spaces group related sessions, PRs, and files around a
  feature so multiple agents share context instead of rebuilding it.
- **Interoperability**: Devin Desktop runs external agents (Claude Agent,
  Codex, OpenCode) over ACP rather than locking to Cognition's own agent.
- **Delivery path**: hands back a pull request.
- **Notable absence**: no agent-to-AI coordination inside one Devin —
  coordination is the coordinator session's job.

### 4. OpenCode

- **Delegation model**: primary agents invoke subagents via a `subagent`
  tool; the parent's subagent permission controls which agents it may call.
  Subagents are also directly @-mentionable by the operator. Community
  plugins add the missing fleet layer: `task_bg` delegates without blocking
  the main conversation, with a PolicyResolver per agent
  (`background`/`foreground`/`ask`) and `/task list|show|kill|logs`; herdr
  adds `herdr_delegate`, `herdr_delegate_bg`, `herdr_delegate_status`,
  `herdr_delegate_close`, multiplexor panes per worker, and an orphan sweep
  that reclaims panes whose sessions disappeared externally.
- **Authority surface**: agent definition files carry per-agent tool
  permissions; anything not selected is denied. Delegation blocking vs
  background is a per-agent policy decision.
- **Failure modes**: async delegation was a feature request, not core
  (#5887); forked subagent sessions corrupt navigation state (#20766); ACP
  mode subagents emit no session/update output, making authorization and
  monitoring impossible (Qwen #952).

### 5. Claude Code

- **Delegation model**: hub-and-spoke orchestrator-worker; subagent
  definitions live in `.claude/agents/` as markdown with tool scoping, auto-
  loaded and invoked by name. Agent teams add built-in orchestration where
  workers can communicate laterally, not only with the orchestrator.
- **Authority surface**: per-subagent tool permission scoping; operator
  defines orchestrator behavior (decomposition, verification) in CLAUDE.md.
- **Industry framing** (Thoughtworks Radar vol. 34): subagents are table
  stakes; "agent teams" (small, coordinated, lateral communication) are
  distinguished from "swarms" (larger, looser).

### 6. Zed

- **Authority surface** (the most developed permission model): agent
  profiles select which built-in and MCP tools a thread may use; tool
  permissions gate each permission-controlled call as allow / deny /
  confirm, with pattern matching (the terminal tool parses chained commands
  and checks each sub-command against patterns). Global auto-approve exists
  but built-in security rules and settings paths still prompt or block.
  Parallel agent threads in one project; external agents via ACP.

### 7. Protocol-level vocabulary (ACP)

- The ACP subagent discussion models delegation as a parent-session tool
  call with `kind: "subagent"` plus a child ACP session identified by
  `subagent.childSessionId` — delegated work rides the ordinary session
  lifecycle, not a separate subagent lifecycle.
- `availableSubagents` is session-scoped (catalogs can vary by workspace,
  configuration, permissions).
- Per-prompt `delegation` policy: `auto` (agent chooses), `disable` (must
  not spawn; reject if impossible), `prefer` (use the named subagent when
  appropriate).
- The session-fork RFD addresses context inheritance; Qwen's fork-subagent
  design quantifies why (5 fresh subagents = 5x prompt cost; a shared cached
  prefix saves 80%+).

## Cross-Product Synthesis

- **Delivery converges on PR + human merge.** Copilot, Cursor, and Devin all
  end at a pull request a human reviews and merges. Cursor's automated
  review tier is the only move toward agent-side merge, and it is a vendor
  cloud feature, not a local-harness pattern.
- **Fleet UX converges on a status board plus per-run thread.** Mission
  Control, Agent Command Center, and the OpenCode plugins all pair a
  list/board of runs with a full per-run session view. Kanban state
  (queued/running/delivered/blocked) is the shared vocabulary.
- **The delegation tool set is small and stable.** Spawn (with instructions,
  optionally background), status/poll, message/steer, cancel/kill, and
  result retrieval. herdr and bg-subagents independently landed on the same
  four-to-five verbs.
- **Permissions are profile-based and deny-by-default.** Zed profiles,
  OpenCode agent files, and Claude subagent definitions all scope tools per
  agent with denial as the default; Zed adds per-call allow/deny/confirm
  with pattern bounds.
- **Observability is the first casualty.** The recurring failure mode across
  products is delegated work becoming opaque (ACP subagents with no
  session/update output) or unowned (orphan panes/sessions needing sweeps).
  Reconciliation and honest liveness are prerequisites, not polish.
- **Context inheritance is an open cost problem.** Session fork (ACP RFD,
  Qwen) exists because fresh workers re-pay full context; harnesses that
  cannot fork will pay prompt cost per worker or under-instruct them.

## Non-Goals Of This Hub

No product ranking, no recommendation. The translation into nucleus
architecture and contracts lives in
`../translation-memos/agent-orchestration-lane.md`.
