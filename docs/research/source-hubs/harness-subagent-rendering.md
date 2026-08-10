# Harness Subagent Rendering Source Hub

Status: open
Owner: Tom
Updated: 2026-08-10

## Purpose

Collect evidence for how agent harness apps render sub-agent / child-agent
activity to the operator, before the nucleus harness decides how to present
provider-owned child work. This is the observation-side complement to the
portable subagent model in Swallowtail contract 045
(`/Users/tom/Dev/projects/swallowtail/docs/contracts/045-subagent-topology-observation-and-control.md`):
snapshots, statuses, parentage, and directories map onto what these products
show, but no product recommendation or ranking is made here.

Each section records, where evidence exists: how a child first appears when
spawned, its in-transcript representation, live progress, output access,
parallelism display, failure/cancellation presentation, and attribution.
Where no evidence could be found, that absence is stated explicitly rather
than guessed.

## Sources

- Claude Code sub-agents: `https://code.claude.com/docs/en/sub-agents`
- Claude Code commands: `https://code.claude.com/docs/en/commands`
- Claude Code desktop app: `https://code.claude.com/docs/en/desktop`
- Claude Code agent view: `https://code.claude.com/docs/en/agent-view`
- Codex subagents: `https://learn.chatgpt.com/docs/agent-configuration/subagents.md`
- Codex CLI docs: `https://learn.chatgpt.com/docs/codex/cli.md`
- Codex TUI source: `https://github.com/openai/codex` (paths below)
- Cursor subagents: `https://cursor.com/docs/subagents.md`
- Cursor Agents Window: `https://cursor.com/docs/agent/agents-window.md`
- Cursor multi-agent help: `https://cursor.com/help/ai-features/multi-agent.md`
- Cursor background agents help: `https://cursor.com/help/ai-features/background-agents.md`
- Cursor agent overview: `https://cursor.com/docs/agent/overview.md`
- Zed agent panel: `https://zed.dev/docs/ai/agent-panel.md`
- Zed parallel agents: `https://zed.dev/docs/ai/parallel-agents.md`
- Zed tools: `https://zed.dev/docs/ai/tools.md`
- OpenCode agents: `https://opencode.ai/docs/agents/`
- OpenCode TUI source: `https://github.com/anomalyco/opencode` (paths below)
- Kimi Code agents docs: `https://moonshotai.github.io/kimi-code/en/customization/agents.md`
- Kimi Code changelog: `https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md`
- Kimi Code web inspector source: `https://github.com/MoonshotAI/kimi-code` (paths below)
- t3code: local checkout `/Users/tom/Dev/projects/nucleus/external/t3code` (repo paths below)
- Goose subagents guide: `https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/subagents.mdx`
- Goose ACP/TUI blog: `https://github.com/aaif-goose/goose/blob/main/documentation/blog/2026-04-08-goose-acp-and-new-tui/index.md`
- Junie CLI worktrees: `https://junie.jetbrains.com/docs/junie-cli-worktrees.html`
- Aider docs: `https://aider.chat/docs/usage/modes.html`; `https://aider.chat/docs/`; `https://aider.chat/HISTORY.html`
- Windsurf Agent Command Center: `https://docs.windsurf.com/windsurf/agent-command-center.md` (redirects to `https://docs.devin.ai/desktop/agent-command-center`)
- Windsurf Fast Context: `https://docs.windsurf.com/context-awareness/fast-context.md`

## Evidence By Product

### 1. Claude Code (CLI and desktop app)

- **First appearance when spawned**: delegation appears in the transcript as a
  tool call row showing the subagent name followed by a short task description,
  e.g. `code-improver (Suggest code improvements)`
  (`https://code.claude.com/docs/en/sub-agents`, quickstart). As of v2.1.198
  subagents run in the background by default; a foreground run is used when
  Claude needs the result before continuing (same page, "Run subagents in
  foreground or background").
- **In-transcript representation**: inline tool-call rows in the main
  transcript. A "subagent panel below the prompt input shows the full tree:
  each row displays a `(+N)` count of descendants, and as of v2.1.193, opening
  a row shows that subagent's siblings and direct children with a path back to
  `main`" (same page, "Let subagents spawn their own subagents").
  `/tasks` lists the current session's background work including subagents
  that have finished (`https://code.claude.com/docs/en/commands`); a completed
  background subagent stays listed marked done and sorted below running work
  until session cleanup, while subagents that fail or are stopped leave the
  list (sub-agents page, "Run subagents in foreground or background").
- **Live progress**: a running background subagent streams no activity into the
  main transcript; its results reach Claude as a completion notification in a
  later turn, and if asked about progress Claude reports it is still running
  (sub-agents page). Live subagent status is available in the panel and via
  `/tasks`; named background subagents currently running also appear in the
  `@`-mention typeahead with their status next to the name (same page).
- **Output access**: only the subagent's final report returns to the main
  conversation (sub-agents page, "What loads at startup" / "Common patterns").
  Individual subagent transcripts persist as
  `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`
  and can be resumed via `SendMessage` (same page, "Resume subagents").
- **Parallelism**: multiple subagents run concurrently; the default concurrent
  limit is 20 running subagents, configurable via
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (same page, "Concurrent subagent
  limit"). The panel shows the whole tree with descendant counts.
- **Failure and cancellation**: foreground: a subagent cut off by an API error
  returns partial output with a note, or fails with
  `Agent terminated early due to an API error`; background: the subagent is
  marked failed and the message to Claude names the error and includes last
  output (same page, "API errors in subagents"). The user can stop a subagent
  with `x` in `/tasks` or an SDK `stop_task`; a user-stopped subagent does not
  auto-resume (same page, "Resume subagents"). Permission prompts from
  background subagents surface in the main session and name the requesting
  subagent (same page, "Run subagents in foreground or background"). `Ctrl+B`
  backgrounds a running task (same page).
- **Attribution**: `color` frontmatter field — "Display color for the subagent
  in the task list and transcript. Accepts `red`, `blue`, `green`, `yellow`,
  `purple`, `orange`, `pink`, or `cyan`" (same page, "Supported frontmatter
  fields"). Tool-call rows carry the subagent name and description.
- **Desktop app**: the Code tab layout includes "chat, diff, browser,
  terminal, file, plan, tasks, and subagent" panes
  (`https://code.claude.com/docs/en/desktop`, "Arrange your workspace"). "The
  tasks pane shows the background work running inside the current session:
  subagents, background shell commands, and dynamic workflows... Click any
  entry to see its output in the subagent pane or stop it" (same page, "Watch
  background tasks").
- **Non-goal evidence**: agent view (`claude agents`) is a screen for
  independent background sessions, not subagents — "Subagents and teammates a
  session spawns aren't listed as separate rows"
  (`https://code.claude.com/docs/en/agent-view`).

### 2. OpenAI Codex (CLI TUI and desktop app)

- **First appearance when spawned**: subagent activity appears in the main
  thread and in a dedicated surface. Official docs: "Current local Codex
  releases enable subagent workflows by default. Subagent activity appears in
  the ChatGPT desktop app, Codex CLI, and the IDE extension"
  (`https://learn.chatgpt.com/docs/agent-configuration/subagents.md`,
  Availability). The desktop app "surfaces each subagent thread so you can
  inspect its work and the summary returned to the main chat" (same page,
  app surface).
- **In-transcript representation**: the TUI renders collaboration tool calls
  as inline history rows: `• Spawned <nickname> [role] (model effort)`,
  `• Sent input to <agent>`, `• Waiting for N agents` (with per-agent detail
  lines when more than one), `• Finished waiting` with one status line per
  agent, `• Closed <agent>`, `• Resuming/Resumed <agent>`
  (`https://github.com/openai/codex/blob/main/codex-rs/tui/src/multi_agents.rs`,
  functions `spawn_end`, `interaction_end`, `waiting_begin`, `waiting_end`,
  `close_end`, `resume_begin`, `resume_end`). SubAgentActivity items render
  dimmed inline lines: `Started \`agent_path\``, `Interacted with
  \`agent_path\``, `Interrupted \`agent_path\`` (same file,
  `sub_agent_activity_history_cell` and `sub_agent_activity_summary`; also
  `thread_transcript.rs` fallback rendering).
- **Live progress**: per-thread previews. The `/agent` status view renders a
  "Sub-agents running" header, then per thread a title line
  `• \`agent_path\`` and up to 3 preview lines from the last 6 activity items
  (agent message, command, file change, MCP tool call, collab action)
  (`https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/agent_status_feed.rs`,
  `AgentStatusHistoryCell`, `AgentStatusThreadPreview`). Subagents also stream
  their own thread, which can be opened with `/agent` while it runs.
- **Output access**: "The main thread collects the subagent results into its
  final response" (subagents doc, CLI surface). Each subagent runs in its own
  agent thread; `/agent` switches between active agent threads and lets the
  operator inspect the ongoing thread (same page). The desktop app shows the
  summary returned to the main chat and lets the operator open the subagent
  thread from the activity shown in the main thread (same page, app surface).
- **Parallelism**: several concurrent children appear as separate threads in
  the `/agent` picker/status view, each with a green running dot (closed
  threads render a plain dimmed dot) and a name like `nickname [role]` or
  `Main [default]` (`https://github.com/openai/codex/blob/main/codex-rs/tui/src/multi_agents.rs`,
  `agent_picker_status_dot_spans`, `format_agent_picker_item_name`).
  `agents.max_concurrent_threads_per_session` caps concurrently open spawned
  threads (subagents doc, Global settings).
- **Failure and cancellation**: per-agent status vocabulary rendered with
  colour: `Pending init` cyan, `Running` cyan bold, `Interrupted` yellow,
  `Completed` green with a message preview, `Errored` red with an error
  preview, `Shutdown`, `Not found` red (same file, `status_summary_spans`,
  `error_summary_spans`). A failed spawn renders `Agent spawn failed` (same
  file, `spawn_end`). Approval requests can surface from inactive agent
  threads; the overlay shows the source thread label and `o` opens that
  thread before approving (subagents doc, Approvals and sandbox controls).
- **Attribution**: agent nickname rendered cyan bold, role in brackets (e.g.
  `worker`), falling back to the raw thread id; spawn rows append model and
  reasoning-effort in magenta, e.g. `(gpt-5.6-terra high)`
  (`multi_agents.rs`, `agent_label_spans`, `spawn_request_spans`).
- **Web surface**: ChatGPT Work shows read-only **Active** and **Done**
  subagent lists; a completed subagent can be selected to inspect details and
  result (subagents doc, Managing subagents, web surface). No control from the
  web sidebar.
- **Sources**: docs (subagents page) plus TUI source files cited above
  (`codex-rs/tui/src/multi_agents.rs`,
  `codex-rs/tui/src/app/agent_status_feed.rs`,
  `codex-rs/tui/src/thread_transcript.rs`).

### 3. Cursor (agent UI, including background/parallel agents)

- **First appearance when spawned**: docs describe delegation as Task tool
  calls from the agent: "Agent sends multiple Task tool calls in a single
  message, so subagents run simultaneously"
  (`https://cursor.com/docs/subagents.md`, "Parallel execution"). No official
  documentation describes the visual row/panel that appears on spawn.
- **In-transcript representation**: not documented in primary sources. The
  subagents page documents behaviour (foreground blocks until complete;
  background returns immediately and works independently) but not the
  rendering.
- **Live progress**: "Background subagents write output to
  `~/.cursor/subagents/`. The parent agent can read these files to check
  progress" (subagents page, FAQ "How do I see what a subagent is doing?").
  This is agent-readable progress, not a described operator UI element.
- **Output access**: the subagent returns a final message with its results to
  the parent (subagents page, "How subagents work"); "Each subagent execution
  returns an agent ID" used to resume with full context (same page, "Resuming
  subagents").
- **Parallelism**: `/multitask` "runs async subagents in parallel instead of
  queuing your requests"; from a plan, "Build in Parallel" runs independent
  steps at once (`https://cursor.com/help/ai-features/multi-agent.md`). At the
  session level, the Agents Window provides "parallel agents" managed from a
  sidebar, plus worktrees for isolation
  (`https://cursor.com/docs/agent/agents-window.md`).
- **Failure and cancellation**: "The subagent returns an error status to the
  parent agent. The parent can retry, resume with additional context, or
  handle the failure differently" (subagents page, FAQ). Cloud/background
  agents demo work via artifacts (videos, screenshots, logs) attached to the
  PR (`https://cursor.com/help/ai-features/background-agents.md`).
- **Attribution**: no documented colour/icon scheme for subagents in primary
  sources. Subagents carry `name`/`description` frontmatter; "description...
  shown in Task tool hints" (subagents page, "Configuration fields").
- **Absence noted**: no primary source was found describing how Cursor renders
  a running subagent row in the chat (icon, spinner, collapsible detail, or
  separate child view). The `~/.cursor/subagents/` file output is the only
  documented progress surface.

### 4. Zed editor (agent panel)

- **First appearance when spawned**: Zed Agent exposes a `spawn_agent` tool:
  "Spawns a subagent with its own context window to perform a delegated
  task... The parent agent continues its work and reviews the subagent's
  findings when it completes"
  (`https://zed.dev/docs/ai/tools.md`, "Other Tools"). No documentation
  describes the operator-facing appearance of a spawned subagent.
- **In-transcript representation**: not documented. The Agent Panel renders
  one thread per agent conversation; responses stream in "with indicators
  showing which tools the model is using"
  (`https://zed.dev/docs/ai/agent-panel.md`, Overview), but no subagent
  specific row/grouping is described.
- **Live progress**: not documented for subagents. For parallel *threads*
  (not subagents), the Threads Sidebar shows "title, status indicator, and
  which agent is running them"
  (`https://zed.dev/docs/ai/parallel-agents.md`, "Threads Sidebar").
- **Output access**: not documented for subagents. The parent thread review
  surface ("Review Changes" accordion, multi-buffer diff tab) is for the
  agent's file edits, not subagent reports (agent-panel page, "Reviewing
  Changes").
- **Parallelism**: parallel work is modelled as multiple independent threads
  (Threads Sidebar, `https://zed.dev/docs/ai/parallel-agents.md`), each with
  its own agent, context window, and history; worktrees isolate file edits.
  Subagent-level parallelism display is not documented.
- **Failure and cancellation**: not documented for subagents.
- **Attribution**: not documented for subagents; thread entries carry the
  agent name (parallel-agents page).
- **Absence noted**: Zed documents the `spawn_agent` capability but no public
  documentation of how subagent activity is rendered to the operator. The
  Threads Sidebar is a thread-level surface, not a subagent tree.

### 5. OpenCode (TUI sub-agent rendering)

- **First appearance when spawned**: a Task tool part appears as an inline
  tool row in the transcript, `separate: true`, with spinner while running and
  `✓` when completed; heading text is
  `{Agent} Task{( background)} — {description}` (e.g. `General Task — ...`)
  (`https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/index.tsx`,
  component `Task`, helper `formatSubagentTitle`).
- **In-transcript representation**: inline rows in the parent session. A hint
  line is rendered under any message containing task parts:
  `[shortcut] view subagents`, with `· [shortcut] background` appended when
  foreground task parts are running and background-subagent capability is
  enabled (same file, hint `Show` block). Clicking a task row navigates into
  the subagent's own child session (same file, `Task` onClick).
- **Live progress**: the running task row shows a live sub-line: `↳ <Current
  tool> <title>` for the most recent tool, or `↳ N toolcalls`; a retrying
  subagent shows `↳ Retrying (attempt N) · message` in the error colour; a
  completed row appends `↳ N toolcalls · <duration>` (same file, `Task`
  content memo; `formatSubagentToolcalls`, `formatSubagentRetry`,
  `formatCompletedSubagentDetail`).
- **Output access**: subagents create child sessions; navigation is via
  keybindings — `session_child_first` (default `<Leader>+Down`) enters the
  first child session, `session_child_cycle` (Right) / reverse (Left) cycle
  children, `session_parent` (Up) returns
  (`https://opencode.ai/docs/agents/`, "Usage"). While inside a child session,
  a `SubagentFooter` renders the label (agent name parsed from the session
  title, e.g. `General`), sibling index/total, token usage and cost, plus
  parent/prev/next hints (`https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/subagent-footer.tsx`).
- **Parallelism**: multiple subagents run as sibling child sessions of one
  parent; the footer shows `index/total` among siblings, and the child-cycle
  keys move between them (subagent-footer.tsx; session/index.tsx `children`
  memo and `moveChild`).
- **Failure and cancellation**: a failed/errored task part renders through the
  same inline row with the error colour (`color={retry() ? theme.error :
  undefined}`) and clicking shows a retry-error dialog (session/index.tsx,
  `Task`). Message-level errors render in a left-border error box (same file).
- **Attribution**: the row title carries the subagent type (from
  `input.subagent_type`, defaulting to "General") and the task description;
  a `(background)` suffix marks background runs (`formatSubagentTitle`).
- **Sources**: OpenCode docs agents page plus TUI source files
  `packages/tui/src/routes/session/index.tsx` and
  `packages/tui/src/routes/session/subagent-footer.tsx` (branch `dev`).

### 6. Kimi Code CLI

- **First appearance when spawned**: "Each dispatch is presented in the
  terminal as an approval request (unless it matches an allow rule or YOLO
  mode is active), giving you a chance to review the task description"
  (`https://moonshotai.github.io/kimi-code/en/customization/agents.md`,
  "How to Invoke"). The `Agent` tool itself is allowed by default so the main
  agent can delegate without interrupting the user (same page, "Permission
  Inheritance").
- **In-transcript representation**: subagents render as cards in the TUI.
  Changelog: "Keep subagent cards at a stable height and show a live status
  spinner with a compact two-row activity window"
  (`https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md`,
  entry `#1345`). Swarm runs render as "a single inline tool card that shows
  live subagent progress and the aggregated result" (web, entry `#1425`).
  Foreground commands and subagents can be moved to background tasks with
  `Ctrl+B` and inspected via the `/tasks` panel (entry `#821`).
- **Live progress**: "Show the full accumulated progress of a subagent in its
  detail panel, with concise tool-call summaries instead of raw JSON"
  (entry `#1109`); "Clarify grouped subagent progress with active status
  breakdowns and elapsed time" (entry `#587`); "Restore real-time token
  display for running subagents in the TUI" (entry `#86`); the `/swarm`
  command runs agent swarms "with live progress and rate-limit-aware
  retries" (entry `#424`).
- **Output access**: "results are automatically returned to the main Agent
  upon completion, with no manual polling needed"; a sub-agent instance can be
  called back to continue the same task (agents doc, "How to Invoke"). Its
  "intermediate reasoning and tool call records do not mix into the main
  Agent's history" (agents doc, "Context Isolation and Resource Cost").
  Runtime state persists per sub-agent in the session directory under
  `agents/` with a `wire.jsonl`; background sub-agents expose lifecycle status
  through a `tasks/` subdirectory (agents doc, "Storage Location in the
  Session Directory").
- **Parallelism**: "Multiple sub-agents can run in parallel without
  interfering with each other" (agents doc, "Context Isolation and Resource
  Cost"); the TUI groups subagent progress (entry `#587`); swarm members are
  tracked as a list (web, "Restore the AgentSwarm member list after a page
  refresh", entry `#1719`).
- **Failure and cancellation**: stop messages for subagents and background
  tasks are clarified as user-initiated (entry `#189`); subagents time out by
  default: a fixed 30-minute timeout with concise resume instructions on
  timeout (entry `#470`), later raised to a 2-hour default via
  `[subagent] timeout_ms` (entry `#651`) and aligned across engines as a
  fixed 2-hour default (entry `#1704`); a run waits for background subagents to finish in
  print mode (entries `#1371`, `#1452`, `#2675`).
- **Attribution**: the web inspector renders agent nodes with a type pill
  (`main`/`sub`/`independent`), monospace agent id, optional swarm-item pill,
  parent id, wire record count and protocol version, and home directory;
  children nest with a left border (`https://github.com/MoonshotAI/kimi-code/blob/main/apps/vis/web/src/components/subagents/SubagentNode.tsx`).
  The session detail page has an Agents tab with a subagent count
  (`.../apps/vis/web/src/pages/SessionDetailPage.tsx`), and a per-agent detail
  page with Wire and Context tabs (`.../apps/vis/web/src/pages/SubagentDetailPage.tsx`).
  Note: `apps/vis` is Kimi's web/`kimi web` inspection surface; the TUI is the
  primary CLI interface and is evidenced through the changelog entries above.
- **Sources**: Kimi Code agents docs page plus `apps/kimi-code/CHANGELOG.md`
  and `apps/vis/web/src/**` in `https://github.com/MoonshotAI/kimi-code`.

### 7. t3code (local checkout at `/Users/tom/Dev/projects/nucleus/external/t3code`)

- **First appearance when spawned**: the provider adapters normalize
  sub-agent tools to a `collab_agent_tool_call` activity item. ClaudeAdapter
  classifies tool names containing `agent`, `task`, `subagent`, or
  `sub-agent` as `collab_agent_tool_call`
  (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, `classifyToolItemType`);
  the OpenCode adapter maps the `task` tool the same way
  (`apps/server/src/provider/Layers/OpenCodeAdapter.ts`). The item title
  defaults to `Subagent task` (ClaudeAdapter.ts), and the label is built from
  the tool input — description, or a 200-char prompt slice, prefixed with the
  subagent type when present, e.g. `code-reviewer: <description>`
  (ClaudeAdapter.ts, tool-call label construction).
- **In-transcript representation**: work entries render inline in the
  conversation timeline as rows with icon, heading, and preview text
  (`apps/web/src/components/chat/MessagesTimeline.tsx`, `SimpleWorkEntryRow`).
  `collab_agent_tool_call` uses a hammer icon (MessagesTimeline.tsx,
  `workEntryIconName`). Turn folding collapses an assistant turn to a
  chevron row (same file, fold state + `TimelineRowContent`).
- **Live progress**: the timeline shows a `working` row while a turn is in
  flight — three pulsing dots plus elapsed text
  (MessagesTimeline.tsx, `WorkingTimelineRow`). No per-subagent live stream
  was found; the row's success/failure indicator flips when the tool call
  settles (see below).
- **Output access**: a collab-agent tool row expands to show raw body when
  one exists (`buildToolCallExpandedBody`), but the adapter stores a
  description/prompt label, not the child's full output
  (ClaudeAdapter.ts). Child results return to the main conversation as normal
  assistant activity.
- **Parallelism**: no dedicated multi-subagent view found. The timeline shows
  concurrent tool calls as sibling rows in the same turn; ClaudeAdapter
  auto-starts a synthetic turn for assistant output arriving without an
  active turn (e.g. background agent/subagent responses between prompts)
  (ClaudeAdapter.ts, turn auto-start logic).
- **Failure and cancellation**: a failed tool call shows an `X` icon with a
  "Failed" tooltip and destructive styling; settled calls show a check icon
  ("Completed") or minus icon ("Empty"); a runtime warning shows a warning
  icon (MessagesTimeline.tsx, `SimpleWorkEntryRow` indicator logic).
- **Attribution**: rows carry the tool title/label (e.g. `Subagent task`,
  `code-reviewer: ...`); no per-subagent colour/icon scheme beyond the shared
  tool row styling was found. Grep for `Subagent` across
  `apps/web/src` returned no matches — no dedicated subagent panel or separate
  child view exists in the web app.
- **Sources**: repo paths
  `apps/server/src/provider/Layers/ClaudeAdapter.ts`,
  `apps/server/src/provider/Layers/OpenCodeAdapter.ts`,
  `apps/web/src/components/chat/MessagesTimeline.tsx` in the local checkout.

## Optional Products

### Amp

No public evidence found. Docs at `https://ampcode.com/docs` redirect to a
sign-in page (`https://auth.ampcode.com/...`), and GitHub repository search
found no public source repository for the Amp agent. Marked per stop
condition: no rendering evidence, no guess.

### Goose

- **In-transcript representation**: CLI renders subagent tool calls inline
  with visual indicators: `[subagent:16] text_editor | developer` — subagent
  identifier, tool name, and extension name; the desktop app shows subagent
  tool calls as expandable sections within the conversation (tool name,
  arguments, output)
  (`https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/subagents.mdx`,
  "Monitoring Subagent Activity").
- **Failure**: "If a subagent fails or times out (5-minute default), you will
  receive no output from that subagent. For parallel execution, if any
  subagent fails, you get results only from the successful ones" (same page).
  Parallel tool output returns an `execution_summary` with
  total/successful/failed task counts and elapsed seconds (same page,
  "Internal Subagents").
- **Note**: the Goose TUI is being rebuilt on ACP (TypeScript TUI beta "in
  progress" as of 2026-04-08), so the current rendering surface is in flux
  (`https://github.com/aaif-goose/goose/blob/main/documentation/blog/2026-04-08-goose-acp-and-new-tui/index.md`).

### JetBrains Junie

No subagent rendering documented. Junie models parallelism as multiple live
sessions in one terminal: `/new` starts another task while the current session
stays live in the background; `/history` lists sessions with statuses
`Working…`, `Awaiting input`, `Ready`, or a relative saved-session time;
`/worktree` isolates file changes
(`https://junie.jetbrains.com/docs/junie-cli-worktrees.html`). No agent-spawns-agent
(child) rendering surface was found in Junie docs.

### Aider

No subagent feature evidenced. Grep for "subagent" across
`https://aider.chat/docs/` and `https://aider.chat/HISTORY.html` returned no
matches. Architect mode pairs a main model with an editor model in a single
conversation (two LLM requests, one transcript)
(`https://aider.chat/docs/usage/modes.html`, "Architect mode and the editor
model") — a model handoff, not a child-agent display.

### Windsurf

The Agent Command Center is a Kanban-style board of all agents — local and
cloud — grouped by status, "so you can see at a glance what each agent is
working on, what is blocked, and what is ready for review"
(`https://docs.windsurf.com/windsurf/agent-command-center.md`, which redirects
to `https://docs.devin.ai/desktop/agent-command-center`). Fast Context is
described as "a specialized subagent that retrieves relevant code from your
codebase"
(`https://docs.windsurf.com/context-awareness/fast-context.md`); no
documentation of Fast Context's operator-visible rendering was found.

## Comparison Table

Rows are the evidence items; cells summarise what each product's primary
sources show. "—" means no public evidence found (see product section for the
exact absence).

| Evidence item | Claude Code | Codex | Cursor | Zed | OpenCode | Kimi Code | t3code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| First appearance when spawned | Tool-call row with agent name + short task description | Activity in main thread; per-surface: CLI `/agent` threads, app surfaces each subagent thread | Task tool calls from the agent (visual row not documented) | `spawn_agent` tool exists; operator appearance not documented | Inline Task tool row `{Agent} Task — {description}` | Terminal approval request presenting the task description | Timeline row titled `Subagent task` or `type: description` |
| In-transcript representation | Inline tool rows + subagent panel below prompt showing tree with `(+N)` descendant counts | Inline collab-event rows: `Spawned`, `Sent input to`, `Waiting for N agents`, `Finished waiting`, `Closed`, `Resumed` | Not documented | Not documented (thread panel only) | Inline rows with progress sub-lines; child sessions reachable via child-cycle keys | Subagent cards with stable height; `/tasks` panel; swarm inline tool card | Inline work rows in the conversation timeline; per-turn folding |
| Live progress | None streamed to main transcript; panel/`/tasks` show status; @-typeahead shows status | `/agent` status view: per-thread title + up to 3 preview lines of recent activity; running dots in picker | Parent agent reads `~/.cursor/subagents/` files; operator UI not documented | Not documented | Row sub-line shows current tool or `N toolcalls`; retry lines; footer shows tokens/cost in child | Status spinner + compact two-row activity window; detail panel with full accumulated progress and tool-call summaries; real-time token display | `working` row with pulsing dots; row indicator flips on settle |
| Output access | Final report only; per-subagent transcripts on disk, resumable | Main thread collects results; each subagent thread openable via `/agent` | Final message to parent; agent-id resume | Not documented | Child session per subagent, navigable; footer shows index/total | Results auto-returned to main agent; per-subagent `wire.jsonl` in session dir | Label/description in row, expandable raw body; child results return as normal assistant activity |
| Parallelism | Concurrent subagents (default limit 20); tree panel | Separate threads in `/agent` picker; `max_concurrent_threads_per_session` cap | `/multitask` parallel subagents; Agents Window parallel sessions | Parallelism is separate threads, not subagents | Sibling child sessions with cycle keys and `index/total` | "Multiple sub-agents can run in parallel"; grouped progress; swarm member list | Concurrent tool rows in one turn; synthetic turns for background responses |
| Failure & cancellation | Foreground: partial output or `Agent terminated early`; background: marked failed; stop via `/tasks`; Ctrl+B backgrounds | Per-agent status colours: Running/Interrupted/Completed/Errored/Shutdown/Not found; approval overlay shows source thread (`o` opens) | Error status returned to parent agent; parent retries/resumes | Not documented | Error-colour row; retry dialog on click | User-initiated stop messages; timeout (2h default) with resume instructions; print mode waits for background subagents | Failed rows: `X` icon + "Failed" tooltip + destructive styling |
| Attribution | Name + description in row; per-agent `color` frontmatter (8 colours) for task list and transcript | Nickname (cyan bold) + `[role]` bracket; model + effort in magenta on spawn; raw thread-id fallback | `name`/`description` frontmatter shown in Task tool hints; no colour scheme documented | — | Agent type from `subagent_type` (default "General") + description; `(background)` suffix | Type pill (`main`/`sub`/`independent`), agent id, swarm pill, parent id, record counts (web inspector) | Tool title/label; shared tool-row styling only |
| Primary sources | code.claude.com docs (sub-agents, commands, desktop, agent-view) | learn.chatgpt.com subagents doc + codex-rs TUI source (`multi_agents.rs`, `app/agent_status_feed.rs`, `thread_transcript.rs`) | cursor.com docs (subagents, agents-window, multi-agent, background-agents) | zed.dev docs (tools, agent-panel, parallel-agents) | opencode.ai docs/agents + packages/tui source (session/index.tsx, subagent-footer.tsx) | moonshotai.github.io agents doc + apps/kimi-code/CHANGELOG.md + apps/vis web source | Local checkout: apps/server/src/provider/Layers/ClaudeAdapter.ts, OpenCodeAdapter.ts; apps/web/src/components/chat/MessagesTimeline.tsx |

## Batch Log

Surveyed 2026-08-10 on branch `thread/092-subagent-rendering-survey`.

What I searched:

- Official docs for all seven required products, plus Goose, Junie, Aider,
  Windsurf, and Amp (docs pages cited above).
- Open-source TUI/UI source for Codex (`codex-rs/tui`), OpenCode
  (`packages/tui`), and Kimi Code (`apps/kimi-code/CHANGELOG.md`,
  `apps/vis/web`), read directly from GitHub.
- t3code sub-agent UI in the local checkout
  (`/Users/tom/Dev/projects/nucleus/external/t3code`), including a grep for
  `Subagent`/`subagent` across `apps/web/src`.
- Claude Code docs index (llms.txt), Cursor sitemap (llms.txt), Zed docs
  index (llms.txt), Codex/ChatGPT docs index (llms.txt), Windsurf docs index
  (llms.txt), Goose docs sitemap, and Aider docs + HISTORY for subagent
  mentions.
- GitHub search for a public Amp repository (none found).

What I could not find (absence recorded as data in the sections above):

- Cursor: any primary documentation of the visual rendering of a running
  subagent (row, spinner, panel, collapsible detail). Only behaviour
  (foreground/background, `~/.cursor/subagents/` output files, error status
  return) is documented.
- Zed: any documentation of how a `spawn_agent` subagent is rendered to the
  operator. The Threads Sidebar is a thread-level surface for parallel
  agents, not a subagent tree.
- Junie: no subagent (agent-spawns-agent) feature or rendering documented;
  parallelism is multiple live sessions.
- Aider: no subagent feature at all (no matches in docs or changelog).
- Amp: docs are auth-gated and no public source repository exists, so there
  is no public evidence of its sub-agent rendering.
- t3code: no dedicated subagent panel or separate child view in the web app;
  subagent tool calls render as ordinary timeline work rows.

Unverifiable items:

- Codex desktop-app screenshots exist in the docs as illustrations
  ("Codex desktop chat showing two subagents working in parallel", "Codex
  desktop Subagents panel") but were not visually inspected here; the
  described behaviour is cited from the page text.
- Claude Code `/agents` wizard and panel visuals changed across v2.1.x
  releases; the cited behaviour is from the current docs (v2.1.198+ era).
- Goose rendering is documented as transitioning to an ACP-based TypeScript
  TUI (beta "in progress" per the 2026-04-08 blog post), so its CLI rendering
  may change.

Stop conditions: none triggered. Web access worked; no contradiction was
found between the governing refs and this card.
