# 065 — A host-agnostic ACP task session

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-11-17
Decision: 5e9a3193 (a generic ACP agent in core, parenting per host) and
f590582a (build T3+ACP), Tom 2026-11-17.
Governing refs: [Spec 058](058-responsible-tasks.md) (responsible tasks),
[t3code host adapter](t3code-host-adapter.md) (the host that first needs it),
[service boundary](../contracts/service-boundary.md) (the callback socket and the
catalogue), [orchestration contract](../contracts/orchestration.md) (unknown
delivery, owner verbs).

## Problem

A Nucleus task is hosted in another product's thread. That product shows the
task only as an agent conversation: its lifecycle is invisible, and anything the
operator types reaches a model rather than Nucleus. The T3 code adapter needs a
task thread whose "model" authors nothing — it dispatches the worker and the
reviewer as its own children, so a task is one row in the sidebar with its
lifecycle as the thread's messages.

That thread is not a T3 feature. It is an Agent Client Protocol (ACP) provider
that speaks JSON-RPC over stdio and is a thin client of the running service.

## Design

### 1. The agent: ACP over stdio, no model, no host

`shared/acp/agent.ts` implements exactly the protocol an ACP client drives and
nothing else:

- `initialize` answers `protocolVersion`, `agentCapabilities.loadSession: true`
  (T3 fails every turn without it), `agentInfo` naming `nucleus`, and no auth
  method — a session is authorized by its binding, not by an ACP auth flow;
- `session/new` and `session/load` resolve the thread's working directory to a
  bound session and attach to the service. If no binding exists, `session/new`
  instead opens an inert session advertising the same models; its prompts refuse
  with guidance and never reach the service. `session/load` still refuses. The attach always answers with the
  task's current lifecycle line, even when this service already showed that line
  to an earlier agent process for the same session: a relaunched agent has
  nothing else to display. `session/load` replays nothing because Nucleus holds
  the task's history;
- `session/prompt` holds the turn while the service says to, shows the
  lifecycle lines the service sends as `session/update` agent messages, and
  forwards a person's text from a task session. The inbox never forwards prompt text.
  It also raises each service-projected decision as a concurrent native form and
  returns the operator's answer or cancellation receipt. A host that released a turn re-enters the
  thread with a prompt of its own, and the binding's `holdPattern` names it:
  nothing is shown, nothing is forwarded, and the turn is held, which is what
  gives the host's next child a live parent run (nucleus#1305);
- `session/cancel` ends the held turn at once, so the client can steer;
- `session/set_model` accepts the two advertised models.

Two models are advertised (`nucleus` and `nucleus-quiet`) because an ACP client
may require a list and T3 requires at least two. They differ only in their
display name: the agent has no model, so the choice has no effect.

The thread's opening prompt is not forwarded. It establishes the thread itself
(an ACP client prefixes its own instructions), and the operator's later prompts
are the messages. Exactly one prompt holds that slot per session, and any first
prompt takes it — including one the agent does not answer. A host's waking
notification that arrives before the operator's first message therefore cannot
turn that message into an opening prompt and swallow it. Anything the agent must *not* answer arrives as configuration,
never as parsing: the binding may carry an `ignorePattern` and a `holdPattern`
the host adapter supplies, and `NUCLEUS_ACP_IGNORE_PATTERN` /
`NUCLEUS_ACP_HOLD_PATTERN` override them for a host that cannot mint one. A prompt
matching the ignore rule ends the turn silently: nothing is shown and nothing is
forwarded, which is how a host's own waking notification stays out of the task. A
prompt matching the hold rule is the same silence with the turn kept open, which is
how a host re-enters a thread it released so the thread has a live run to parent its
next child. Both are regular-expression sources the host adapter owns; the agent
parses no remote text and knows no host. The two rules stay distinct on purpose: a
notification has nothing left to do, a re-entry exists to keep the run alive.

The agent keeps no durable state. Killing it and relaunching it reattaches from
the binding and the task row.

### 2. The binding is minted, never read from text

`shared/acp/binding.ts` owns the shapes, the paths and the pointer read;
`core/acp/binding.ts` owns minting and verification, under `<data home>/acp/`:

- `sessions/<task id>.json` is the authority: `{sessionId, taskId, tokenHash,
  createdAt}`, owner-only. Minting again for the same task replaces it, so every
  earlier token stops working at once.
- `bindings/<sha256(checkout)>.json` is the pointer the agent reads:
  `{sessionId, taskId, socketPath, token, ignorePattern?, holdPattern?}`,
  owner-only, keyed by the canonical path of the checkout the client launches the
  agent in.

Nothing is written into the checkout, so a bound session never appears in
`git status`. The token exists only in the pointer and as a hash in the record:
it is never returned by an RPC, printed by the CLI, or written to a log. A
request is authorized by the record — a wrong token, another task's record, or a
replaced session all refuse as the store's one unauthorized-callback class, so
the socket answers 401 and no refusal distinguishes the cases.

`acp.bind` (`shared/rpc/acp.ts`) is the one catalogue method: it mints the
session for a task that has a checkout and answers with the session id and the
pointer's path. Host adapters call it in-process before they open a task's
thread; an operator calls it from the CLI to register the agent in an
ACP-capable app by hand. A process that serves no ACP sessions refuses it
instead of minting a pointer nothing answers. The catalogue method names only the
task; a host adapter calls `bind` in-process with its own `ignorePattern` and
`holdPattern`, which is how the T3 adapter's parent thread is armed before it is
launched.

### 3. The service API: hold, release, lifecycle text

`core/acp/sessions.ts` serves three callback routes on the existing callback
socket, authenticated by the minted token:

- `POST /acp-turn` `{taskId, sessionId, waitMs, attach?}` answers
  `{state: "hold" | "release", reason, messages, task}`. `waitMs` is 0 for an
  attach and up to 25 s for a held turn. The answer is derived from the task
  row, never cached as a decision:
  - `hold` while the task is unfinished; `messages` carries a lifecycle line the
    first time and whenever the label the operator reads or the PR link changes,
    and nothing when neither has changed (a version bump, a poll, a re-entry);
  - an attach (`attach: true`) always carries the current lifecycle line,
    whatever this service already showed for that session. The stored signature
    suppresses only the repetitions a held turn would otherwise make;
  - `release` when the task is terminal, or when a host adapter called
    `release(sessionId, reason)`, provided no operator decision is open. A release directive is consumed by the turn
    that acts on it and the next turn holds again, which is what "release the
    parent between children, re-enter by message" needs. Directives are
    memory-only, so a service restart re-derives the answer from the task.
- `POST /acp-answer` authenticates a task or host-scoped inbox session, checks the
  offered decision and version, and records an operator answer or cancellation receipt.
- `POST /acp-message` `{taskId, sessionId, eventId, text}` records the
  operator's text through the existing message route and answers its receipt.

`core/acp/lifecycle.ts` owns the text. A line is a milestone: the state label
`shared/task-state` already owns, plus the PR. The session's first line names the
task's reference, and the PR link appears once (`PR #N` after that). The
signature is the label and the PR link, so a version bump, a poll or a re-entry
that changes neither sends nothing. A reattached session gets the whole line
again, because its thread shows nothing from before. The agent never composes
task text of its own.

The agent writes each line as its own paragraph (`text` plus a blank line),
because clients join message chunks without a separator. It also skips a line
identical to the one a session showed last, so a repeated attach cannot repeat it.
The hold rule for a host's re-entry is an exact match. On the installed nightly
(`0.1.11-nightly.20261119.4928`) a `system`-created re-entry holds the run too, but T3
shows it as a user bubble, so there is no quiet re-entry to use. Current parents hold the
plain sentence the adapter sends (`Nucleus keeps this task thread open for its
next role.`); a parent launched before that change keeps the legacy marker its
binding names.

### 4. The operator's text is an operator message

`AgentMessages.operatorMessage` records the text as a message from the operator
about its own task — the one sender with no agent behind it (`fromRole:
"operator"`) — and delivers it through the existing message machinery to
whoever is doing the work: the worker when the task has one, else the reviewer,
else the planner ladder. It is information only, like every message: no
authority, no brief change, no hold change, and the recorded duplicate and rate
rules apply. The agent never answers operator text itself, and a failed forward
ends the turn with the reason rather than resending.

## Failure behaviour

- The service unreachable at `session/new`/`session/load` refuses the session
  with the reason: no session id is invented.
- The service unreachable mid-turn ends the turn after three failed calls with
  one line naming the failure. A turn nobody can release is worse than a
  settling one.
- A prompt while a turn is in flight is refused (`-32602`); the client cancels
  and sends the person's text as a new prompt, which is exactly how an ACP
  client steers.
- A closed stdin ends every held turn: a host that shuts down leaves no process
  holding a turn nobody can release.
- The agent never retries a message: unknown delivery is not permission.
- A process that serves no ACP sessions refuses the routes rather than
  answering an empty turn.

## Verification

`test/acp-agent.test.ts` drives the agent over stdio with recorded ACP traffic:
initialize, new, load (and a mismatched load), a held prompt with the lifecycle
line and its release, an operator prompt forwarded, an ignored wake prompt (also
when it is the session's first prompt, so the operator's next message is still
forwarded), an empty first prompt, cancel and the following steer, a prompt
refused while in flight, a service that never answers, a service unreachable at
session/new, the refusal codes, a closed stdin, and the launched entry point's
missing-binding answer.

`shared/acp/transport.ts` is the agent's socket client and `shared/acp/entry.ts`
reads the environment and launches it; `bin/nucleus-acp.mjs` is the installed
command, written to `~/.local/bin/nucleus-acp` by the installer as the absolute
command path an ACP client registers.

The agent tests also cover the hold rule: a re-entry prompt shows nothing, forwards
nothing, holds the turn until the service releases it, and leaves the operator's
next message still forwarded; an ignore rule ends the turn while a hold rule holds
it. The service tests prove a mint carries both host rules into the binding and
that a mint without them writes neither.

`test/acp-service.test.ts` covers the service side against a real store, engine
and callback socket, including a spawned `bin/nucleus-acp.mjs` speaking ACP to
the real service: minting and revocation, the catalogue method, the bind
refusals, hold and lifecycle text, an attach after this service already showed
the session's line, the long poll, the release directive, the operator message
and its duplicate rule, the 401/409 refusals, a process with no ACP surface, the
lifecycle line's signature, verification across a restart, and a relaunched
launcher whose `session/load` shows the line the dead process had already shown.

Affected unit files cover the rest; `effigy check` and `effigy qa:docs` gate the
docs.

## T3 inbox and decision forms

A T3 inbox is a second binding kind scoped to a host, with its own owner-only
credential and dedicated directory. It has no task identity and cannot invoke the
task message route. The service projects operator decisions into native ACP
forms; the agent holds several requests at once and sends accepted answers or
cancel receipts back over the authenticated callback. The service checks the
decision version and the session's scope before recording an operator answer.
Task bindings continue to use their checkout and task identity. T3-specific
thread creation, card settlement and restart behavior belong to the
[T3 adapter](t3code-host-adapter.md#operator-decisions-on-t3).

## Not in this spec

Parenting role threads as ACP children of this session, and registering the
Nucleus provider in T3, are the host adapter's work
([t3code host adapter](t3code-host-adapter.md), "Native parenting"): it holds the
turn while a child is active or a decision needs the operator, releases it when neither applies, and re-enters with a
`holdPattern` prompt before the next child. Registering the provider
is one operator setting (`nucleus-acp` is the installed command path); a drift
in the client's ACP revision is the adapter's compatibility check, not the
agent's.
