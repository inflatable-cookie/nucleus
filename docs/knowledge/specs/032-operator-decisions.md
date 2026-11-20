# 032 — Operator decisions

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-29
Decision owner: Tom ("I approve the decisions proposal", Nucleus thread, 2026-09-29)
Governing refs: [Spec 026 planning records and board](026-planning-records.md), [Spec 030 routing](030-routing-changes.md),
[orchestration contract](../contracts/orchestration.md)

## Problem

Chatterboxes ask Tom for rulings at the end of a turn, in chat. With many
cross-agent messages in flight, those questions are easy to miss, and nothing
durable records what an agent is waiting on or needs to return to. Nucleus's own
escalations are the only durable attention signal.

## Outcome

An agent records a question that needs the operator as a **decision** in Nucleus.
The board shows all open decisions. The operator can also answer in the Paseo
composer pill or in T3. In T3, operator questions for T3-hosted tasks appear
on their parent threads. Other decisions routed to that T3 operator appear in
the pinned Nucleus inbox. See [operator decisions on T3](t3code-host-adapter.md#operator-decisions-on-t3).
Decisions clear when answered, withdrawn or superseded. Answers reach the
asking agent.

## Record

A decision has:

- `id`, `version`, `createdAt`, `updatedAt`;
- `headline` (a plain-language, single-line question of at most 140 characters),
  `choices` (two or three `{label, consequence}` pairs), and `recommended`
  (one choice label). Nucleus-authored decisions provide those fields with real
  consequences. An authorless headline uses the final interrogative sentence,
  prefixed by its task reference when linked, and shortens at a word boundary
  with an ellipsis. Creation and supersession always supply choices and a matching
  recommendation. At the blocker ladder's operator handoff, a bare
  `Decision: operator` classification or options that only defer planning
  without concrete choices and consequences do not create an operator decision
  and instead return the escalation occurrence to the planner ladder for a
  recommendation (Tom, 2026-11-20). Still-open legacy placeholder ladder
  decisions without explicit options or stored choices are withdrawn by their escalation
  settlement owner (preserving history without manufacturing an operator answer)
  and returned to the planner; genuine operator rulings, permission requests,
  and already answered decisions stay untouched. Outside that blocker-ladder
  handoff, if choices are missing on creation or supersession, Queue offers
  returning to the planner for a recommendation or keeping the task held; a
  single option gains a hold alternative, and legacy free-text decisions receive
  the same choices when read.
  `details` holds the longer context and evidence. Tom, 2026-11-04: a stopped task's
  question must escalate to the planner or provide recommended options.
- `question` (required) and optional `context`, `options` (short labels) and
  `recommendation`;
- `askedBy`: the asking agent thread. The CLI records the calling thread; a
  typed name is never trusted. Nucleus derives the project and task from that
  identity: a run ticket (worker, reviewer, coordinator, executor) gives the
  task, its repository and its project, and links the task; a planner or
  named-agent participant ticket gives its project; otherwise the linked
  tasks, leads or papercuts give the project. An explicit `project` that
  contradicts the caller's identity is refused, and a decision Nucleus cannot
  place is refused instead of filing under General. An operator adding a
  decision at the board picks a project.
- Legacy project-less decisions belong to the **General** surface. New
  decisions are always placed; `decision.backfill` retargets legacy rows
  where the asker still resolves and leaves ambiguous ones as is.
- links: zero or more task IDs, lead IDs and papercut IDs. They are part of the
  content snapshot each version records;
- `status`: `open`, `answered`, `withdrawn` or `superseded`;
- when answered: `answer` text, `answeredBy`, `answeredAt`, and `relayed` with
  the relaying agent when an agent recorded it;
- when withdrawn: the reason; when superseded: the replacing decision ID.

Every change is versioned; a stale version is refused, as for leads. The content
snapshot includes the links, so a link-only edit has a history entry that records
it (task #231). A snapshot whose links were never recorded reads `links: null`
(unknown, never empty). That state is preserved and never filled from the
current record: a portable import omits version links, so synthesizing them from
the record's links would fabricate history for an imported decision.

## Methods

- `decision.add` — an agent records an open decision.
- `decision.get`, `decision.list` — filter by status, asker, project, task,
  lead or papercut.
- `decision.answer` — records the operator's answer. The board and Paseo pill
  carry direct operator authority. Nucleus also records an answer from an
  authenticated T3 task parent or inbox as a direct operator answer, with
  `answeredBy: operator (t3code:<hostId>)` derived from the session's host.
  The session can answer only decisions offered to it at the current version.
  That identity is reserved for authenticated T3 sessions. Agent relays
  record the relaying agent, quote the operator verbatim and name the approver
  in the note, with `relayed: true`.
- `decision.withdraw` — the asker (or the operator) withdraws an open decision
  with a reason.
- `decision.link` — adds task, lead and papercut links to an **open or answered**
  decision in place. `tasks`, `leads` and `papercuts` are merged into the current
  links (omitted lists and already-linked entries are unchanged); a call that
  adds nothing writes no version. Linking changes only traceability: on an
  answered decision its question, answer, answerer and status stay unchanged.
  Withdrawn and superseded decisions cannot be linked. Linking never supersedes
  a decision or changes its id.
- `decision.backfill` — retargets project-less decisions at the asker's
  project (`{dryRun}` previews the counts without writing). The project is
  not versioned content, so the write is in place with no new version; an
  ambiguous asker and unresolvable links are left as is.
- `decision.supersede` — replaces an open decision with a new one in one step.

Direct T3 answers can sign off routing requests and activate planner grants
under [Spec 052](052-usage-level.md), and can satisfy the proof-only release GO
under [Spec 055](055-source-immutable-proof-executor.md).

## Delivery

Answering commits the decision version and schedules one durable notice to the
asking agent's thread through a coalesced, bounded delivery owner on its own
lane, independent of the serial fleet reconciliation sweep. Both T3 Inbox and
board answers use the shared answer path, which preserves an independent wake
for task effects while delivering decision notices without waiting behind slow
task reconciliation.

Startup, resume, unpause, host reconnect and bounded backoff retries route
through that same delivery owner; the serial fleet sweep does not send decision
notices. Per-recipient ordering stays FIFO while independent recipients run
with bounded concurrency and per-step timeouts so a busy, unavailable or slow
recipient stays pending and cannot monopolize delivery to an unrelated
reachable recipient.

Notices use the deterministic version identity (`decision:<id>:<version>`) and
the shared durable send path (`intent` before send, fresh recipient and host
availability checks, pause gates). Notification failure never rolls back the
committed answer: an agent that resumes still lists its answered decisions.
Proven pre-send refusals, busy threads and unavailable hosts keep the notice
pending for retry; interrupted `intent` records on restart and non-pre-send
send failures settle as `uncertain` and are never resent blindly (a late
acknowledgement on an abandoned send settles `uncertain` to `delivered` without
resending). An answer the asking agent relays itself sends no notice: that
thread already has it (Tom, 2026-09-29).

## Staleness

When every linked task, lead and papercut has reached a terminal state, an open
decision is marked stale on the board. It is never closed automatically; the
asker or the operator withdraws it.

A planner may name exact decision IDs in a brief amendment's `overtakes` list or
in the `Overtakes:` line of its `northstar_ask` answer. A board decision answer
may also carry an explicit `overtakes` list. Nucleus marks each still-open cited
decision **probably overtaken**, shows the citing amendment or answer, and offers
one-click withdrawal. It never infers a match from similar wording.

## Board

- Open agent decisions appear in the Decisions column of the Tasks tab's
  Pipeline, with the one-line headline, recommended choice first, one-line
  choice consequences, who asked, links and age. Who asked is the project, the
  task reference and role (for example `swallowtail#234 worker`), or the
  planner or agent name — never a bare agent or thread ID. Full details stay
  collapsed. The separate Decisions tab was retired on 2026-10-03 (Tom).
- Nucleus-raised items, including escalated merge holds and future close-out
  prompts, appear in the same Decisions column. Only item kinds that explicitly
  grant operator actions expose them; other Nucleus-raised cards remain read-only.
- General decisions remain visible in the Decisions column under every project
  filter. All projects includes General as well.
- A General decision that links tasks shows the linked task project names as a
  muted hint. This does not change the decision's project.
- Linked task, lead and papercut cards show a decision chip.
- An agent decision opens in a modal with its options, recommendation and an
  answer box; answering applies immediately. The composer pill uses the same
  compact form and keeps details collapsed.

## In Paseo

While any decision is open, every thread's composer shows a pill
(`addComposerPill`) with two counts: open decisions for that thread's project
and for all projects ("1 here · 3 all"). A thread outside any project shows the
total alone ("3 decisions"). The pill goes when the last open decision is
answered, withdrawn or superseded; chat scrolling never hides it. Tom asked for
this on 2026-10-21, because a pill on the asking agent's thread alone was
rarely where he was looking. A thread's project is the project of the task its
agent works on, else the project whose repository holds its working directory
(`decision.agent-projects`, read-only); a decision's project is
`projectKey`, derived from its asking repository on every read. Pressing the
pill opens a popover with a This project / All switch, starting on the project
when it has an open decision. Each decision shows its question, options and
recommendation and an answer box, which calls `decision.answer` with operator
authority, and the popover links to the board view. It labels a decision
without a project as General.
Tom chose the pill over an inline timeline card because the chat moves too fast
for a card to stay visible (Nucleus thread, 2026-09-29).
Paseo 0.12 sizes plugin popovers itself (280–420 pt wide, 440 pt tall, scrolling its content); the popover fills that box (Tom, 2026-10-21: a window-sized 720 pt popover overflowed it).
Each decision reads in this order: question, the recommendation (clamped, with
Show more), the context (clamped), the options as full-width rows (the
recommended one tagged), then the answer box with Answer beside it. Tom asked
for this on 2026-10-01, because a block of recommendation text had separated
the options from the answer.

## Agent rule

A Chatterbox that ends a turn needing an operator ruling records a decision
instead of only asking in chat, and withdraws it if the question is overtaken.
The Nucleus skill (`nucleus`) states this rule.

## Compatibility with the retired Nucleus system

The separate retired Nucleus system's Queue-compatible service implemented the
same methods and record. A decision is local to this product, Nucleus, with its
version history and delivery summary; `stale` is derived, never stored. A version
snapshot's `links` (task #231) stay host-local. This product no longer exports
decisions: its portable-record producer was retired on 2026-10-31
([Spec 029](retired/029-portable-records.md)). The optional contract 008
`decisions` kind remains part of the retired system's contract and owns the
format for that system's records store; only this product's export is gone.
Imported history preserves task, lead and papercut links without creating their
targets; missing targets read as terminal for staleness. Earlier version-1
exports may omit the kind. The retired system's and Northstar's Chatterboxes
were to be told before the skill changes.

## Out of scope

Decisions grant no execution authority. They record questions and answers;
controls such as `move` or `lead.approve` still act separately.
