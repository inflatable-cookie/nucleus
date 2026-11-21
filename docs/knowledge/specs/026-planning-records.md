# 026 — Planning records in Nucleus

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: nucleus `docs/knowledge/contracts/002-core-requirements.md#planning-records`
and `006-bb-workspace-experience.md#direction` (main 7029b40), [Spec 019](019-lanes.md)
(lanes, many-to-many since its 2026-09-26 revision), [Spec 023](retired/023-brief-drafts.md)
(drafts, approval, promotion), [Spec 024](024-papercuts.md) (papercuts),
[Spec 025](025-outcome-query.md) (outcome search). Nucleus piloted this for the separate retired Nucleus system.

## Problem

Planning still lives in repository files: `docs/plan.md` for intent and order,
`docs/triage/` for leads, and briefs drafted as loose files. Tom's direction is that
repositories keep knowledge and code only. Nucleus already holds papercuts, drafts,
tasks and outcomes. It lacks triage leads, a home for each lane's working intent,
a project's order of lanes, and a single-action path from a note to a task.

## Records

Every record kind attaches to any number of lanes, or none, under the Spec 019
rules: each lane must list the record's repository and be `active` or `paused`.

- **Papercuts** (Spec 024) gain a `lanes` list, set with `papercut.set-lanes`.
- **Triage leads** (new), a permanent, host-neutral table:

  | Field | Content |
  | --- | --- |
  | `id` | Nucleus identity |
  | `title` | Short summary |
  | `body` | Long-form Markdown, up to 1 MB (thousands of lines) |
  | `repositories` | One or more, in the normalised identity used by outcomes and lanes |
  | `lanes` | Zero or more lane keys |
  | `author` | Agent id, `operator`, or `import` |
  | `state` | `open`; `promoted` with a target; `dropped` with a reason |
  | `targets` | For `promoted`: one entry per promotion, each with kind `task`, `question` or `knowledge` (`draft` in history only), the repository for a draft or task, and a reference (draft id, task id, or free text naming the question or knowledge change) |
  | `createdAt`, `updatedAt`, `closedAt` | Timestamps |

  Edits keep the previous body as a version, like drafts. `question` and
  `knowledge` targets are links only: Nucleus does not hold questions or knowledge
  files.
- **Tasks** keep their existing lane fields. (Brief drafts, Spec 023, are retired;
  a lead carries the brief.)

Operations (RPC, CLI and skill): `lead.add`, `lead.edit`, `lead.get`,
`lead.list` (by repository, lane and state, open by default), `lead.set-lanes`,
`lead.drop` with a reason, `lead.reopen` with a reason, and `lead.import`.
`lead.add` and `lead.import` take
a repository as the origin string `papercut.list` uses or as `{origin, path}`;
`lead.add` also accepts `repository` for one origin, and `lead.import` ignores
`author`. A schema refusal names the field and expected shape on one line. The
importer reads one file, or a `docs/triage/` directory where each file becomes
one lead, titled by its first heading. It is idempotent on a content key and reports imported, duplicate and unparsed files.

Lead creation records the registered checkout for its repository origin when one
exists, including when filed from a task worktree. Checks and task promotion
resolve that checkout again by origin, so archived worktree hints in existing
leads do not change their identity, versions, digests or history. Without a
registered checkout, the stored path is used if available; otherwise the
refusal names the origin and missing registration.

## Revision: a mistaken drop is reversible (lead.reopen, 2026-10-14)

Requested through the queue by the Consumer-b web/audit planner (2026-10-14): a
canonical lead was dropped by mistake and getting it back needed a new lead, a
content edit, an approval substitution or a private database repair. Dropping an
ordinary planning lead is therefore reversible with a general, supported local
control — a planning-record lifecycle operation, not a task recovery exception.

`lead.reopen` takes `id`, a nonempty `reason` (trimmed, at most 4000 characters)
and the acting `author`, through the ordinary authenticated RPC and CLI path. It
restores one dropped, non-papercut lead to `open` in one transaction: the id,
title and body bytes, content version, every saved version, checks, approval
history, author, repository and lane membership, tags and targets are carried
through unchanged, no version row is written, and the lead is editable again
through the ordinary `lead.edit` path. Papercuts are refused (`papercut.close`
closes them; they are never dropped), any lead that is not `dropped` is refused
by state, and targets are never silently unpromoted. Reopen causes no automatic
task dispatch, check, edit, approval or promotion, and grants no execution
authority.

The reopen enters durable, inspectable planning history on the lead itself:
`lead.get` carries `reopens`, one entry per drop–reopen cycle, each keeping the
reopening `reason`, `by` and `at`, plus the prior drop's `reason` and time even
though the current dropped-state fields (`dropReason`, `closedAt`) cleared. A
lead dropped again after a reopen appends another episode with its own prior
drop. The audit is Nucleus-local and never exported (the portable-record export
was retired, [Spec 029](retired/029-portable-records.md)): a reopened lead reads
`open` with no drop residue. Repeated or simultaneous requests refuse
whole, so the audit never doubles and nothing is partially written.

`lead.get` returns the current lead with its latest version in full and earlier
versions as metadata, including digest, check, approval, author and creation
time. It also returns `promotedTaskId` when exactly one task target exists;
multi-repository task links remain in `targets`. Its `actions` object gives the
availability of check, approve, drop, reopen and question or knowledge promotion,
plus task promotion per repository origin. Each reason is a string when the
action is unavailable and null when available. These are hints for the returned
version; each mutation rechecks the current record. This keeps historical body size
out of the summary response. `lead.version`
reads one full version by lead id and version number; approval metadata remains
attached to the version it approved. Its CLI reference is in the operator guide; the Nucleus skill names
`lead.get` and `lead.version`.

## One-call authorized submission

`lead.submit` takes one repository, title, brief body, relaying agent and operator
authorization note, plus optional base branch, lanes, tags, host and hold. It
creates the lead, waits for its durable check, records exact-version approval,
and waits for the existing promotion operation to return the task reference.
Failed checks return the lead's findings without approval or promotion.
Resubmitting the same open lead after a failed check starts a new durable check;
concurrent identical submissions join one pending occurrence.

Same-title matching is case-insensitive and trims outer whitespace, scoped to
the resolved repository. An open lead with the same brief digest is checked, approved and promoted; a different brief is refused with the lead ID and `lead.edit` route. Numbered tasks,
including completed, removed and purged tasks, return their task reference.
Lookup and creation do not yield in the service's sole-writer turn, so concurrent
calls cannot create duplicates. Backpressure and uncertain delivery preserve the
existing operation gates and reconciliation reads. Existing methods remain.

## Revision: papercuts are tagged leads (Tom, 2026-09-28)

Tom: papercuts and triage leads are the same kind of record. Keep one table and
simplify the board, but keep the `papercut.*` interface so agents still file
papercuts by name. Migrate every existing papercut without losing data.

- **One table.** Leads gain `tags`: a list of short lowercase tags that agents set
  when filing and can change later with `lead.set-tags`. `papercut` is reserved: it
  marks a lead that came from, or is filed as, a papercut. Other tags are free-form.
- **Papercut fields are kept, structured.** A papercut-tagged lead carries a
  `papercut` object: `area`, `happened`, `impact`, `fix`, `source` (import
  provenance) and `draftId` (history). Its body is rendered from those fields, so
  lead views read it naturally; the structured fields are the source of truth for
  the papercut interface. `filedBy` and `filedAt` map to the lead's `author` and
  creation time, and the one repository becomes `repositories: [repository]`.
- **Closing.** Leads gain a `closed` state with `closure: {reason: completed |
  deprecated, note, at}` for papercut-style closure. `dropped`, with its reason,
  stays for leads.
- **`papercut.*` stays as the agent interface**, retaining its method names and
  IDs: `add`, `list`, `get`, `edit`, `close`, `promote`,
  `promote-task`, `set-lanes` and `import`. Each reads and writes papercut-tagged
  leads. A papercut's ID is its lead's ID. `papercut.list` returns exactly the
  papercut-tagged leads in the requested state, in the papercut shape.
  `papercut.edit` takes the current version and any of `title`, `area`,
  `happened`, `impact` and `fix`, refuses stale versions, and keeps the prior
  editable fields in version history. It preserves the papercut tag, lanes,
  promotion targets and open, promoted or closed state.
  `papercut.promote-task` builds the brief from the papercut fields and admits it
  as today. It preserves the papercut's assigned lanes; when none are assigned, it
  uses the first eligible `now` lane in the repository's saved plan. An unsaved
  plan or no eligible `now` lane leaves the task unlaned. The lead's `targets`
  also records the task.
- **Board.** The Papercuts column goes. Triage shows every open lead as a card: its
  title, a kind chip (`Papercut` or `Lead`), the project and one state line
  (`Checks passed · unapproved`, or a papercut's area). The body, tags, lanes and
  decision links stay in the record. Triage orders checked leads awaiting approval
  first, then other leads awaiting approval, then approved leads awaiting promotion,
  then papercuts, newest first within each (2026-11-07). A row shows eight cards;
  an in-column "…and N more" card loads the next eight, and the column header shows
  the total. The tag filter narrows the cards, the paging and the total. The
  filter is a dropdown listing only the tags on leads Triage shows in the current
  scope, each with its count (Tom, 2026-10-15: cycling through every tag was
  tedious, and tags from other projects or briefed leads matched nothing).
  Reserved tags (`RESERVED_LEAD_TAGS`, today only `papercut`) lead the list
  under their display names in a Reserved group; free-form tags follow
  alphabetically under Tags. The
  record modal shows the papercut fields for papercut-tagged leads and offers their
  Close action. The Papercuts tab was retired on 2026-10-03 (Tom); papercut-tagged
  leads remain reachable in Pipeline Triage, and `papercut.list` continues to
  query records by state.
- **Migration, lossless.** Nucleus takes a verified backup (Spec 028) before
  migrating. Every papercut row becomes a lead with the same ID:
  - it keeps every field, including state, task link, close reason, note and date,
    lanes, import source and draft link;
  - it gets the `papercut` tag.
  The migration is idempotent and runs in one transaction. It proves that counts by
  state and repository are equal, and that every papercut read through
  `papercut.get` is byte-identical before and after. If any check fails, it rolls
  back and Nucleus keeps the old table. The old papercut table is kept, read-only,
  until a later release retires it.
- **Papercut rows** are tagged leads carrying `tags`, `closure`,
  `papercut {area, happened, impact, fix, source, draftId}` and state `closed`.
  The portable-record exporter and importer retired on 2026-10-31
  ([Spec 029](retired/029-portable-records.md)); the stored lead shape is
  unchanged.

## Revision: lead and lane-document version storage (2026-10-25)

Tom (2026-10-25, performance audit), choosing "Lead version storage", "Shrink the DB file", "Lighter backups" and "Slimmer task rows".

The audit measured `lead_versions` at 245 MB of the 1.2 GB store. Every version
stored its full body. One lead (`6a84e627`) had 541 versions and grew to 537 KB,
adding about 40 MB a day. Long-window compression of all versions came to
8.7 MB.

The rules:

- **Storage.** The latest body is stored in full. Older versions are stored as
  reverse deltas against the next version, with a full snapshot at a bounded
  interval.
- **Exact rebuild.** Every version must rebuild byte for byte, and its stored
  digest is checked on every rebuild.
- **Unchanged guarantees.** Approval digests, the version history and every
  existing lead id are unchanged, and no version is ever deleted.
- **Lane documents.** The same storage rule may apply to lane-document versions
  under the same exact-rebuild guarantee.
- **No running logs.** A lead is not a running log. A coordinator records
  progress in task records and receipts, not by appending to a lead body.

### Implemented encoding (schema 46)

The lead and lane-document histories are converted by schema 46 and written
this way from then on. The encoding is Nucleus-local and never leaves the store.
Schema 55 resolves a lead's current body from its current full version when the
bytes match; independently recorded current bodies stay on the lead.

- **Layout.** A version is a *snapshot* when it is the record's latest version
  or a multiple of 32; it keeps its exact text in `lead_versions` /
  `lane_documents`. Every other version's row lives in `lead_version_deltas` /
  `lane_document_deltas`: the same metadata (title, author, creation time,
  recorded digest, check, approval) without the text, the reverse delta, the
  version it is a delta against (always the next version), and `bodyDigest`,
  the SHA-256 of that version's exact bytes. A version is stored in exactly one
  of the two tables, so nothing is kept twice and no version number, id, digest,
  author, time, check, approval or export field moves.
- **Delta format.** `queue.reverse-lines` version 1. The text is split into
  lines that keep their own terminators (so LF, CRLF, a missing final newline,
  an empty body and Unicode all rebuild exactly); the delta is a list of copied
  line runs from the newer body, in increasing and non-overlapping order, plus
  the pool of lines the older body inserted. Repeated lines are treated as junk
  by the matcher (difflib's rule) so a body of blank lines cannot make the diff
  quadratic; they simply travel in the inserted pool. The encoder applies its
  own delta to the newer text and refuses to store it unless it rebuilds the
  older text exactly.
- **Bounded rebuild.** A rebuild starts at the nearest snapshot (never more than
  31 delta applications away) and applies each delta downward. A chain longer
  than the snapshot interval is refused rather than walked: that means a
  snapshot base is missing. A rebuilt version is returned only after its bytes
  match `bodyDigest` and, when the row carries the contract digest of a brief
  body, that digest too. Rebuilt bodies are cached in a bounded cache (at most
  64 entries and 8 MiB); a cache hit is digest-checked again before it is
  served, so the cache never hides corruption.
- **Refusals.** An unreadable or truncated delta, a malformed operation, an
  inserted-line range that is not stored, a copy outside the base, a base whose
  bytes do not match the delta's recorded base digest, a missing base version,
  an unsupported format string or format version, and a rebuilt body that does
  not match its stored digest each refuse the read with their own message
  naming the record and version. The stored history is never silently
  substituted, partly returned or repaired.
- **Writes.** A new version is written in full and, unless it is a snapshot
  point, the version it supersedes is demoted to a reverse delta against it in
  the same transaction. A check or approval writes that exact version's
  metadata and never reconstructs or rewrites its text. A papercut edit that
  preserves its prior rendered body only ever rewrites the current version,
  which is always stored in full.
- **Migration.** Schema 46 converts every existing history inside its own
  transaction: each converted version is read back out of the new row and
  rebuilt against the newer body, and the step refuses if any version's bytes or
  metadata would change, so a refused conversion rolls back to the untouched
  full text. A history that already holds reverse deltas (a rewound backup) is
  re-encoded from its whole reconstructed history instead. The pre-migration
  snapshot is taken before the schema steps; an older build refuses the file by
  schema version rather than reading a row it cannot resolve.
- **Restore.** A backup carries the full text and the reverse deltas
  unchanged, and a store restored from it reconstructs identical bytes and keeps
  identical digests. Nucleus's portable-record export/import and its contract 009
  seed export were retired on 2026-10-31; old exports stay inert history.
- **Approval and promotion compare original bytes.** `lead.approve` compares the
  digest of the lead's current body, and promotion and source re-resolution
  compare the digest of the reconstructed stored version, never a patch or a
  delta.

The measured ledger lead (`6a84e627`) is not a storage special case: its root
author stopped appending to it when this ruling was made, and Nucleus adds no
ledger-specific control. Growth from a running ledger stays a usage mistake
rather than something the encoder hides.

## Revision: lead reads never parse a history to answer a narrower question (2026-10-25)

Tom's performance audit item B7. The read shapes are owned by
[the service boundary](../contracts/service-boundary.md), "Responsiveness":

- `lead.get` carries the current version in full and every earlier version as
  metadata, with the superseded bodies removed inside SQLite. Every version is
  still listed, with its digest, check, approval, author and creation time.
- A check or approval update writes the exact version it checked, and a
  promotion reads the exact version or the version digests it pins — never the
  version list.
- The drain pass and any open-lead read use `leads_state`, so they parse the open
  leads rather than every retained lead.
- Lane activity reads a maintained lead-to-lane index rather than `json_each`
  over every lead body.

Storage, digests, approvals and exports are unchanged; the delta storage is
owned by the revision above, and the ledger-style lead stays a usage mistake
rather than a storage shape.

## Revision: plan reads scale with the current plans (2026-10-25)

Tom (2026-10-25, performance audit), on audit A2: `plans` measured 279 ms and
was polled every 4 s while the board was open, because every project re-read every
lane row and every retained version of its plan, and the Planning tab read one
`plan.get` per project on every poll.

- **One read per call.** `plans` reads the projects once and the lanes once,
  and derives every project's plan from that index. `plan.get` answers from the
  same derivation, so the board and the Planning tab cannot disagree about a
  plan.
- **The Done band is cached, never extended.** The newest saved entry for each
  lane a project's plan ever named is kept against the plan write clock, which
  advances on every `project_plans` write, and its lane side is read from the
  lane revision on every call. A save, merge, import, lane close, reopen or
  project edit is therefore read at once; an unchanged read re-parses no
  retained version. A requested version still reads exactly as saved, including
  the whole saved row and the plan-level fields.
- **One batched plan read.** `plans` returns each current plan projection with
  its saved entries in the same response. Planning does not fan out a `plan.get`
  per project; plan and lane loading or failure stay distinct from an empty
  plan, and a row never reports zero counts before both reads are available.
  `plan.get` remains the exact saved-version read for callers that request one.

The cache rule itself is owned by
[the service boundary](../contracts/service-boundary.md), "Responsiveness". The
isolated benchmark and its population are recorded in
`evidence/plans-read-20261025.json` in Git history.

## Lane documents

Each lane has one working document that planner and operator both edit: what the
lane is trying to achieve, its completion states and caveats. It stays high
level; tasks hold the detail.

- Markdown text with version history: each save is a new version with author and
  time. A save against a version that is no longer the latest is refused with a
  prompt to reload, as for drafts.
- The lane's short `aim` stays what prompts carry. A document reaches a role when
  a brief links it (`queue.laneDocuments: [key]` in brief frontmatter) or names
  its key in prose or a `## Read` list. Nucleus pins the current version at task
  dispatch, records its lane key, version and digest on the task, and gives each role a
  read-only copy in that run's scratch directory with the path in its prompt. A
  reference that does not resolve is named in the prompt. When work continues,
  Nucleus refreshes cited documents whose current version changed. The outcome
  row keeps what each worker run received, alongside brief versions.
- Operations: `lane.document.get` (latest, or a version) and `lane.document.edit`.

`lane.document.edit` also accepts the `digest` returned by `lane.document.get`
as an optional fence on the previous text, alongside the required version. A
mismatched digest refuses before writing a version. `plan.get` returns no digest;
its matching `plan.set` keeps the version fence.

## Project plan

A project's plan is its ordering of lanes, with each lane's intent in its
document. It replaces the repository's `docs/plan.md`.

- One ordered list of lane keys per project (Spec 027; a repository without a
  named project is its own project), each with an optional one-line note. Only
  lanes that list one of the project's repositories can appear. The top of the
  list is what matters now; lower entries wait.
- A lane that gains one of the project's repositories joins the end of that
  project's plan. A cross-project lane has its own position in each project's
  plan.
- Saving a new order is versioned, with a stale-save refusal. Operations:
  `plan.get` and `plan.set`.
- Import: the Chatterbox moves a repository's `docs/plan.md` into lane documents
  and a plan by hand through the CLI, since mapping prose to lanes is judgment.
  Nucleus's `docs/plan.md` and `docs/triage/` are the first imports.

## Implementation notes (g01.059)

- A lead listing several repositories may join a lane that lists any one of them,
  matching the project plan rule.
- Hand promotion is `lead.promote` with kind `question` or `knowledge`; g01.060
  extends the same operation to draft and task targets.
- `plan.get` reads the saved order for open lanes that still list a member
  repository, then appends other open listing lanes in lane creation order. Done
  and abandoned lanes drop out of the plan as read; a requested version reads as
  saved.
- A lane document is bounded at 128 KB because prompts carry it. Linked or cited
  documents are pinned at task dispatch; each role receives a read-only scratch
  copy. A continuation refreshes cited documents when their version changed.

## Promotion without ceremony

Revised 2026-10-08 (Tom, Queue #294): a brief-bearing lead can target an explicit
non-`main` release branch. The branch is part of its versioned approval and task
identity; the ordinary review, merge and synchronization path follows that base.
The older 2026-09-27 ruling (nucleus contract 002 at 9ef5803) removed brief drafts.
A lead carries a brief, and promotion goes straight from lead or papercut to task.
Every step is one action, idempotent on retry, and links its source to its result,
so a lead or papercut can be followed through to its merged outcome (Spec 025).

- **Brief-bearing leads.** A lead's body may be a brief: frontmatter (title,
  `queue:` routing such as lanes, dependencies, lane documents, scope and complexity) and
  Markdown. `lead.add` accepts `baseBranch`, defaulting to `main`; `lead.edit` can
  change it without a body. A base-branch edit creates a version and clears its
  check and approval. Each version is recorded before its pushed-head check is
  queued as a durable operation, using that version's author as the originating agent.
  The check requires a clean named integration checkout, a valid branch name, and
  an exact pushed `origin/<baseBranch>` head; it does not switch the checkout.
  A quick
  check keeps returning the checked lead; while a check is pending, `lead.add` and
  `lead.edit` return its `checkOperationId`, which `lead.get` retains until the result
  is stored on that version. `queue.operation-status` reports progress or failure.
  Editing a lead can therefore correct a brief's originating agent. A failing version
  can't be approved; a new version clears approval.
- **Approval** binds to one lead version's digest, base branch and checked pushed
  head. A new check at a different base or head invalidates the approval; promotion
  rechecks the same base/head and requires fresh approval if that identity moved.
  From the board it is the
  operator's own action. An agent approving through the CLI must supply a note
  naming the operator's authorization, and the approval is recorded as relayed
  (Tom, 2026-09-26); without a note it is refused. A brief that should wait for the
  operator simply stays an open lead until approved.
- **Routine dispatch under standing authority (Tom, 2026-11-20).** The planner
  decides whether to dispatch an ordinary in-scope brief without asking the
  operator for dispatch approval, and records the source of that authority.
  Product or scope changes, held-profile requests, releases and other explicitly
  reserved operator actions still need the operator. The check, digest,
  attribution and promotion gates are unchanged: a CLI approval under the
  standing ruling still carries `relayed: true` with a note naming the standing
  ruling and the brief it covers, never a per-brief operator conversation that
  did not happen.
- **Promote to task.** One action turns an approved lead version, or a papercut, into
  a task. It re-checks at promotion time, is atomic, and is idempotent on the source
  and the admitted version, digest and repository. The admitted approval retains
  its base and head; later checks, approvals or metadata edits cannot admit that
  version again. A refusal records the fresh check and admits nothing. That recheck includes the independent-review routing
  preflight ([Spec 030](030-routing-changes.md)): a required worker/reviewer pair
  that shares a profile or the same normalized model fails the lead check before
  Ready and fails promotion before any task is bound. A promoted lead task keeps the selected base branch through
  worker dispatch, PR identity, exact-head review, merge verification and sync.
  Papercuts continue to use `main`. A
  papercut's text becomes the brief (title, then happened, impact and fix, with
  frontmatter carrying the repository, lanes and `queue_approval` naming the
  promoter and any supplied authorization note; a board promotion names
  `operator (board)`). The task and its outcome keep the generated text as the
  brief. The outcome's `planningSource` names the lead or papercut, and the
  promoted source keeps a tombstone link to its task. The generated approval lets a
  papercut-promoted task pass the same brief validation when an operator later
  amends it.
- **Promotion operation.** Nucleus persists a source-promotion operation before
  the pushed-head recheck. Fast promotions preserve the task result; work still
  running after the bounded compatibility wait returns its operation ID and
  state for `queue.operation-status`. A lead version with its selected approval,
  or a papercut record revision, has a stable operation identity. A fresh approval
  after a settled refusal may create a new attempt; unfinished delivery keeps its
  original operation. On restart, Nucleus reconciles an interrupted source-promotion
  effect against the atomic source/task link: a found task settles as succeeded,
  while an absent link settles as not delivered and permits a same-version retry.
  A genuinely new lead version always has its own promotion key. Admission still
  links the source and task in one transaction, and a different attempt cannot
  admit the same lead version twice. A CLI timeout reports an unknown outcome and
  directs the caller to inspect the source's task link or the operation status
  before retrying.
- **One repository per task (Tom, 2026-09-26).** A lead that lists several
  repositories names the target repository on each promotion and can be promoted
  once per approved lead version in each repository; its `targets` list keeps every
  promotion, and it counts
  as promoted from the first. If a target repository resolves to a different pushed
  head, its fresh check clears the earlier approval and needs its own approval before
  that target can be promoted.
- **Version boundary (Tom, 2026-10-19).** Tom selected “Version-aware lead
  promotion (Recommended)”. A genuinely new current lead version needs the ordinary
  pushed-head check and board approval or attributed agent authorization before it
  can admit one task in the selected repository. A title or base-branch change is
  also a new version, even if its brief digest repeats. The task's submission
  identity includes that version. An earlier cancelled, live or archived target
  does not satisfy promotion of the new version, and new content grants no
  cancellation or supersession authority over earlier work.
  Retries resolve their own admitted version's original task or permanent outcome.
  All targets, version history, approvals, dispositions and receipts remain intact.
  Older targets need no rewrite: Nucleus derives their binding from the task's lead
  provenance or the outcome's admitted approval, source identity, repository and
  saved version text. Missing or contradictory binding refuses explicitly; current
  checks or a matching title alone are not evidence. Papercuts retain one task per
  source despite metadata edits, including reads through the lead interface.
  Request lookup, durable operation execution and the admission transaction use
  this same selection. Queued version/digest/approval changes and transaction-entry
  races refuse without admitting; a resolved duplicate returns its original result
  before consulting mutable check state. Older operation payloads remain readable.
  Unfinished or uncertain delivery is observed before a fresh approval attempt,
  including after the approved head changes. It is never permission to retry blind.
- **Links.** A lead that becomes a question or a knowledge change is marked
  promoted with that target by hand.
- **Existing drafts** are history only. Promoted drafts' text lives in each
  outcome's brief; the optional `briefDrafts` export kind is retired with the
  portable-record export. `draftProvenance` stays on the submission and outcome
  schemas so stored records parse and frozen identity digests hold. Nothing else
  reads it, and review entry refuses any submission that carries one.
- **Unpromoted drafts migrate to leads** (2026-09-27; two approved consumer-b-v2
  drafts were live when the fold landed). The migration turns each unpromoted,
  undeleted draft into a brief-bearing lead in the same repository and lanes. The
  lead keeps the draft's title, every version's text and author, each version's
  check, and an approval bound to the same digest, so an approved draft stays
  approved and promotes in one step. The draft becomes history, marked migrated
  with the lead as its target. It is idempotent: rerunning finds the lead and
  creates no second one. A draft that can't migrate (for example, a repository
  Nucleus no longer knows) keeps the migration refused, naming it, rather than being
  dropped.

## Board

- **An inbox, not columns** (Tom, 2026-11-21). The board is three panes: a menu on
  the left, the open view's list in the middle and the open record on the right.
  Below 1100 points of panel width the detail pane goes and a record opens in a
  modal; below 720 the menu folds into a drawer behind a menu button. The menu is
  **Needs you** (decisions, Nucleus-raised holds, drained-lane prompts and tasks
  needing attention, in one list, newest needing action first), **Planning** (the
  plan in the list pane, the open lane in the detail pane, or a modal without one),
  **Leads** (open leads, with the tag filter and pages of eight), **Papercuts** (open
  papercuts, with pages of eight and no tag filter; Tom, 2026-11-21), **Queue**
  (queued tasks, pending submissions and the per-project "…and N more" rows),
  **Working** (working tasks), **In review** (tasks awaiting or under review) and
  **Closing** (verifying, merging and closing tasks). The menu reads Needs you, a
  divider, Planning, Leads, Papercuts, Queue, a divider, Working, In review and
  Closing; both dividers read at half the border's contrast against the menu
  background. Each entry shows its real total; only Needs you is highlighted.
  An entry whose count is 0 renders dimmed but stays selectable; the selected
  entry keeps its selected styling, and Planning (which carries no count) never dims.
  Opening a view clears the open record. The card-once projection below decides where
  a card goes; the menu groups its columns. Milestone QA is not a board surface: QA
  runs as an ordinary task, and the QA runs tab is gone.
- **Needs you is one list** (Tom, 2026-11-21: "one list of cards, and make the cards
  obvious what they are"). Its header names the count and there are no section
  headers. Each row's kind tile and line 1 say what it is (card anatomy, below). The
  list has one empty state, "Nothing here.", shown only when the total is zero.
- **The Leads filter** sits in the list's header row, after the item count. It offers
  only the tags on leads in the current scope, each with its count, and never the
  reserved `papercut` tag: a papercut-tagged lead is a papercut and sits in Papercuts,
  which has no filter. The menu counts ignore the filter.
- **The header is one row** (Tom, 2026-11-21): the title, a state pill only when
  something is abnormal (paused or draining, dispatch held, stopped threads, queued
  operations, connecting), the project selector, then Settings, Refresh and the Pause
  split button. There is no status line, and a resumed-thread count never earns a pill:
  it outlives the restart it describes (nucleus#1511). Below 720 points of panel width
  the selector collapses to its folder icon button, keeping its accessible label
  ("Projects, <selection>") and the same picker, so the title and the menu button share
  the row with the controls. The queue menu behind the split button holds Pause or
  Resume, Dispatch hold, Stop, the paused note, the slot table (global use, the project
  default and overrides, then each project using a slot) and the bound runs.
- **Columns:** Triage → Decisions → Attention → Queued → Working → Review →
  Closing (Drafts retired with brief drafts; Attention and Closing added, Tom,
  2026-09-27). These are the projection's buckets, which the inbox menu groups.
  There is no Done column (Tom, 2026-09-27): finished and cancelled
  work leaves the board, and outcome search answers what landed.
  Counts are every record in scope once, whatever its lane count, with Queue
  including the cards held back behind its "…and N more" rows. While the board
  loads, a list reads "Loading…"; a failed read reads "Not loaded" and names the
  failure in the error banner. Neither reads as empty.
  Queued is `queued`; Working is `dispatching`, `working` and `changes_requested`
  (revision, with its "changes requested" chip); Attention is `blocked`, `error`
  and `needs_attention`; Review is `awaiting_review` and `reviewing`; Closing is
  `verifying`, `merging`, `syncing` and `closing`.
- **Each card once** (Tom, 2026-11-08: "We can lose the swim-lane rendering
  concept on the board, I never use it"). The board lists every card in scope
  once, whatever its lane count.
  The swim-lane view, its header switch, per-lane rows, row and cell expand and
  collapse, and the card chip naming a shared task's other lanes are retired.
  A card keeps its lane membership, shown in the task view; lane records,
  documents, Planning, lane drain and every lane RPC and CLI route are
  unchanged. Lane discovery is Planning's "Find lanes".
- **The Status view is retired** (Tom, 2026-09-27); the separate Lanes destination
  is folded into Planning (Spec 019, revision 2026-11-07).
- **Badge colours** (Tom, 2026-09-28): card badges take one of four theme
  tones, keyed on their text so tags share them (`shared/badge-tones.ts`).
  - Papercut red, Lead green; the kind distinction matters most.
  - Checks failed red, passed green; Approved blue, Unapproved amber; Submitting
    blue.
  - A task's phase badge is red for blocked, error, needs attention and
    cancelling; amber for changes requested; blue for dispatching and working;
    green from review through closing. A held wait with no work due names its
    target or holder (`Waiting on #248`, `Waiting on Tom`, `Held by planner`);
    a blocked or needs-attention task with a live dispatch or merge fence uses
    that fence's reason and owner as its current wait label;
    a ready merge hold reads `Merge held by <holder>`. Active work keeps its
    phase label, and worker blocks without a holder keep `Blocked`. Separate dispatch and merge hold badges retain their
    existing tones.
  - Everything else (areas, lanes, repository, parked, queued) stays neutral.
  - The tone colours text and outline over the usual badge surface.
- **Cards and long lists** (Tom, 2026-09-27): every card uses the standard card
  component, drawn as a flat row in the inbox list. The list fills its pane and
  scrolls on its own, so the page never grows into one long scroll (Tom,
  2026-09-28). Leads and Papercuts page their cards, and Queue ends with its "…and N
  more" rows.
- **Card anatomy: every card is a three-line row** (Tom, 2026-11-21: the cards were
  "way too noisy right now and need redesigning"; nucleus#1515, which replaces the
  nucleus#1511 row rules):
  - A **kind tile** on the left: one fixed icon and colour per kind — task, decision,
    hold prompt (merge or dispatch), drained lane, lead, papercut. The task tile does
    not change with phase; the status dot and words carry the phase. Tile colours are
    the theme's tone roles at low alpha.
  - **Line 1:** for a task its reference (`#1072`), otherwise the kind in words
    (Decision, Merge hold, Lane drained, Lead, Papercut); then the project by its
    display name (a lane's or lead's projects; a decision's asking repository), with
    the T3 project badge where matched, otherwise the folder icon; the age,
    right-aligned (a stop, wait or hold's start, else the task's last change; a
    decision's ask, a lane's escalation, a lead's or submission's creation). The
    project group shrinks and clips as one unit so the age keeps its place: at most two
    project marks, the rest as one "+N" count.
  - **Line 2:** the title, up to two lines.
  - **Line 3:** a coloured dot, the state in plain words and the single most useful
    detail after a middle dot ("Working · running affected tests", "Needs attention ·
    reviewer launch unconfirmed", "Waiting · on the host", "Checked · awaiting
    approval"). The detail is the existing wait, stop or report wording, shortened,
    never a raw ID. A declared wait names its state and next action, its owner in the
    accessible name (Spec 043). A lead's state follows its current check first:
    unchecked, then checks failed (even with an earlier approval kept), then approved
    or awaiting approval.
  - **Flags**, below, only for exceptions: a dispatch or merge hold, parked,
    interactive, budget reached and the PR as a small flag. A hold flag is dropped only
    when the status line was chosen from that fence (a dispatch hold, a held stop, a
    declared merge-hold wait), never because other text mentions it. The PR flag is a
    link that opens the pull request without opening the task. A normal task shows none.
  - **Buttons** only where the row is the action: the hold prompt's Release and Keep
    (with its reason) and the drained lane's Close lane and Keep. They sit inside the
    row's frame, below its content and outside its press target, so a press on a
    control never opens the record too. Pressing a drained lane's row opens that lane
    in Planning.
  - **Detail only:** routing sentences, host identity and kind, profile names, host
    waits beyond "on the host", attempt counts, report headlines beyond the status
    line, prerequisite counts and promotion, a decision's choices, a lane's aim, and the
    Lead and Papercut kind chips. The task detail's header carries the stop category,
    a stop while paused, linked open decisions and, for an escalated hold, the
    Nucleus-raised badge; its summary names a host outage recorded beside a stop (the
    host and since when); a decision's Links name each task by reference, title and
    project; a drained lane's Planning screen names its Nucleus-raised escalation. The
    row's accessible name keeps the record's own title as written, the status with its
    detail, and the wording the row shortens, with identifiers sanitized only in
    operational text.
- **Pending submissions** (Tom, 2026-09-27): a submitted brief or handoff whose
  operation has not yet created its task shows as a Queued card marked
  "submitting", so an accepted submission is never invisible. Brief-bearing leads
  show in Triage from their first version, with their check and approval state.
- **The detail pane holds one record.** Planning lives in its own menu view (Tom,
  2026-09-27: a planning pane beside the board made it unreadable); the inbox's
  right pane shows only the open task, decision, lead or papercut.
- **Scope: one project selector, single-select by default** (Tom, 2026-09-27;
  single-select nucleus#1421; compact header nucleus#1476). A single project
  selector in the header replaces the single-project filter everywhere. It is a
  dropdown that opens a large popover (a modal at the compact viewport) listing
  every project with a filter box, its primary repository and counts of live tasks
  and open leads, with a checkbox per project. The picker's one top row holds the
  project search at its remaining width and, beside it, a Clear project selection
  icon button (a folder with an X, the same icon-only `Button` style and height as
  the Settings button next to it, its name as accessible label and tooltip, with a
  visible focus state) and the Settings icon;
  Clear sits alone on a host with no Settings action. There is no Enabled switch,
  no All or None row, and no selection-count row (nucleus#1476). The live-task
  total covers every non-terminal task in the project's member repositories and
  adds the hidden portion of each repository's queued snapshot after subtracting
  rendered queued cards, so it includes work beyond the first queue page without
  counting visible cards twice. The compact total appears beside the project name
  and in its accessible label, including when the total is zero. It is computed
  from the current board snapshot and stays independent of selector filtering and
  selection. A plain click
  replaces the selection with that project (clicking the sole selected project
  keeps it selected) and closes the picker; Shift-click toggles just that project
  and keeps the picker open for a sequence of Shift-clicks. The selection (a
  Spec 027 project may hold several repositories; several projects may be chosen)
  scopes every task and planning view: Pipeline, Papercuts and Planning. An empty
  selection means all projects, the app-wide board, with lanes in the order of
  their first appearance across the selected plans. This is
  Nucleus's equivalent of the retired system's per-project-workspace and app-level views.
- **Project actions in the selector** (nucleus#1430, refined by nucleus#1432). Each
  project row has a disclosure chevron, separate from the row's selection, that opens
  a compact panel attached to the row inside the picker, so no nested popover takes an
  outside press. One row's panel is open at a time. Park asks first with Settings' "No
  new work starts" confirmation; a parked project shows Unpark instead. Rename edits
  the name in its own slot: the row's label becomes a focused input seeded with the
  name, with compact Save and Cancel and the count kept in place. Enter saves and
  Escape cancels, neither selecting the row nor closing the picker; a validation
  problem or refused save shows under the input and keeps the draft for a retry, and
  Cancel restores the label. Rename changes the display name only, under Settings'
  rule (1 to 200 characters once trimmed), and keeps the key, repositories and
  selection even when the new name re-sorts the row. Remove from Nucleus sits below
  a divider; it leaves the picker and opens the shared removal dialog, with its
  open-work blockers and confirmation, and never removes in one click. Every save goes
  through the project's version and then refreshes the board and Settings' project
  list. The chevron shows on hover or keyboard focus with a hover pointer, and stays
  visible on touch and in the compact picker. Escape, or back in the compact picker,
  closes an open action before it closes the picker.
- **Per-project workspace board** (Tom, 2026-09-27). The plugin registers a
  workspace panel (`addWorkspacePanel`, context `workspace`, opened as a tab in the
  workspace area) named "Nucleus board", and an "Open Nucleus board" workspace command.
  The panel finds the Nucleus project whose repositories include the workspace's
  project root (`project.get` by repository) and shows the Pipeline and Planning views (lane discovery included) scoped to that project, with the multi-project selector preset
  to it. A workspace outside every Nucleus project shows a plain message. The
  Papercuts view stays in the main surface; Dispatch limits, Profiles (with the
  Subscriptions list beneath the profiles), Projects, Hosts (the host
  catalogue and the default host, nucleus#1325; after Projects, nucleus#1494),
  Backups and Telemetry live
  in Nucleus's native
  Paseo settings screen (`addSettingsScreen`), which the header's Settings icon opens
  through `openSettings` (Tom, 2026-09-27). Its sections are one row of tabs at
  every width, the same component as the main surface's tabs (Tom, 2026-11-09,
  nucleus#963). The project selector's settings icon
  opens it at Projects: `openSettings` carries a section hint the screen takes. The
  retired `subscriptions` hint opens Profiles scrolled to Subscriptions.
- **Parked projects** (Spec 027): the selector and the All-projects view hide
  parked projects by default. A "Parked" section in the selector lists them for
  scoping, and selecting one still shows its views. Unpark sits in the row's
  row panel (nucleus#1430) and in Settings → Projects. The Planning tab groups parked
  projects under Parked. Attention from a parked project is never hidden.
- **Active and dormant projects** (Tom, 2026-11-20, nucleus#1446; brief v3 shortened the window to three days). The selector and
  the Planning tab share one rule. A project is active when at least two distinct
  substantive work items have activity less than three days old. An item is one of:
  - a task, counted once across its submission, execution and lifecycle events, review,
    checkpoints, completion and its completed outcome (a recent completion counts, however old the task
    page is);
  - a lead or papercut that is independently actionable, counted once across its
    versions, and folded into the task it is linked to: a lead whose target names a task, a papercut
    promoted to a task (`papercut_linked`), or a review entry that claimed its source lead
    (`papercut_source_claimed`). Two tasks linked to one lead are one item.
  An executing task (dispatching, working, reviewing, verifying, syncing, merging or closing) is
  recent while it runs, so it counts as one item. It never bypasses the two-item rule: a single
  running or recently finished sweep task stays Dormant, and its task, count and attention stay visible
  through the normal board rules. Plan versions are not items: they are not records. Routine
  observation, bookkeeping, background sweep and reminder events, planner registration and project
  management never add an item. A project with fewer than two recent items, or with no items, appears
  under Dormant whether or not a planner is registered. Parked projects stay under Parked. The store
  reads these facts store-wide and ships each project's recent items (`projectActivity`) on the board
  snapshot, so the selection, task paging and visible rows never change a project's group. Planner
  routing and drain rules are unchanged.
- **Selection is the only filter state** (nucleus#1476, replacing the "Enabled"
  switch of Tom, 2026-09-28; it came from the Pipeline view's "Filter by
  project" switch). An empty selection shows every project in every view the
  selector scopes (Pipeline, Papercuts, Planning), and a selection scopes them.
  The selection persists across plugin reloads in the surface's local storage
  where it has one, otherwise for the session; it is never written to Nucleus's
  store, and the workspace panel's preset (its own project) lives in the panel.
  A legacy stored preference is read once, in `readProjectScope`: a stored
  selection whose retired switch was off opens as an empty selection, so the
  board shows all projects after the upgrade, and a stored active selection is
  kept as it is. Only the selection is written back, so the retired field is
  gone after the first save.
- **Record modal; actions live there** (Tom, 2026-09-27). Clicking a Triage (lead)
  or Papercuts card opens a detail modal, the same way a task card opens task
  detail; the board no longer switches tabs or expands the card. Cards carry no
  action buttons. The lead modal is the shared lead screen described below. The
  papercut modal shows what happened, impact, suggested fix, area, lanes, filer and
  date; its actions are Edit, Promote and Close (completed or deprecated) with a note.
  Actions are disabled with the reason when they don't apply (for example, Approve
  on a failing version), and results and errors show inside the modal.

## Revision: the lead screen (nucleus#868, 2026-11-08)

Tom, 2026-11-07: Planning is "horrible to use right now - works fine for agents
but is really hard to do anything with as an operator". The lead record is the
first operator version of it, in the shared `client/lead-screen.tsx` both shells
render. The lane document `nucleus-ui` (U5) carries the design.

- **The brief and its checked version sit together.** The brief is read as text,
  with Markdown headings set as headings; a lead with no body says "No brief
  written yet." instead of showing an empty box. Beside it, one panel holds the
  check for the version on screen and one holds its approval.
- **Three separate actions, each with its own answer.** Check, Approve and Promote
  are separate controls, and each reports its own result or refusal beside itself,
  so a failure in one never reads as another's outcome. An unavailable action
  states why. Approve sends the version and digest on screen, and Promote names
  the repository when a lead lists more than one.
- **Approval is for the checked version.** The approval panel names the approved
  version and who approved it, and says when an agent relayed the operator's
  authority rather than the operator acting. A new version clears the check and
  the approval on the record; the screen reads the version history, so the last
  checked and the last approved version stay named as out of date rather than
  disappearing, and asks for the existing recheck. An out-of-date check offers
  that version's own brief through `lead.version`, so the operator can read what
  was checked beside what is current. A lead, its approval and a lane document
  still grant no dispatch authority, and the screen says so.
- **Secondary actions carry their reasons.** Drop, reopen and the hand promotion
  to a question or knowledge change sit behind More actions, each with the reason
  or reference it requires; a dropped lead is reopened only from there. Papercuts
  keep their own record and actions.
- **Details on demand.** Raw ids, digests, base branch, repositories, lanes, the
  brief's frontmatter, promotions, reopens and every version stay behind Details.
  A long version list shows the latest eight and offers the next eight, with the
  true total.
- **Lead lists page honestly.** The lane screen's open lead and papercut lists show
  eight records and offer the next page, from the lane's complete read: the count
  and "Showing 8 of N" are the lane's total, never a first page presented as one.
  A loading or failed read still shows no count at all.

## Planning tab

> Superseded in part by [Spec 041](041-planning-roadmap.md) (Tom, 2026-10-03): one project at a time, Now/Next/Later/Done bands, `doneWhen`, and lane close-out prompts. The Lane column stays.

Planning is a menu view of the inbox board (Tom, 2026-11-21; top-level since
2026-10-03; the Lanes tab was folded into Planning in Spec 019's 2026-11-07 revision).
The header's project selector chooses the projects (Board, "Scope"); Planning has no
chooser of its own since 2026-11-21. It has two panes:

- **Plan:** for each selected project, a flat row — the list's divider, and an accent
  edge on the expanded row — that opens and closes the project's lanes, with that
  project's lanes in plan order, each with its live-task count and last activity,
  grouped under **Now** and **Later** (each plan entry
  carries `horizon: now | later`; existing entries are `now`). Up and down
  controls reorder, and a move between groups changes the horizon; saving writes a
  new plan version with the stale-save refusal. Lanes that list one of the
  project's repositories but are not in its plan appear below, with one action to
  add them.
- **Lane:** the lane's aim and projects, its document, and its work, leads and papercuts
  (`client/lane-screen.tsx`, Spec 041 part 4). The document shows a preview and a
  readable full text with earlier versions. Editing sends the version the text was written
  against; a newer version blocks the save until the operator picks it as the base or
  discards their text. Leads and papercuts (open leads tagged `papercut`) come from every
  project that lists the lane, not the chooser's selection, so their counts are the
  lane's own; a lane no project lists falls back to the projects in scope. Counts show
  only from complete reads. Lane key, repositories and status actions sit behind Details.

The plan fills the list pane and the lane the detail pane. Without a detail pane
(below 1100 points), the lane opens in a modal over the plan, and closing it returns
to the plan. Editing uses the existing dark-theme styling.

## Tasks and order

1. **g01.059, records:** leads, papercut lanes, lane documents and project plans,
   with RPC, CLI, importer and skill. Depends on g01.058 (many-to-many lanes).
2. **g01.060, one-step promotion:** promote papercuts and leads with links and
   relayed approval. Depends on g01.059.
3. **g01.061, pipeline board:** columns, swim lanes (retired 2026-11-08), planning pane, actions and the
   fallback toggle. Depends on g01.060.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Lead add, edit, get, list, set-lanes, drop | Round-trip; open by default; body versions kept; drop needs a reason |
| 2 | Lead or papercut joins two lanes; an unknown, closed or non-listing lane | Joined, in order; refused whole |
| 3 | Import a `docs/triage/` directory, then again | One lead per file, titled by the first heading; the rerun reports duplicates |
| 4 | Lane document edits by agent and operator; a stale save | Versions with author and time; stale save refused, nothing written |
| 5 | Brief links or cites a lane document in prose or `## Read`; it is edited after dispatch; a later continuation sees an unresolved key | Each role prompt names its read-only scratch copy; task/outcome and worker-run records retain the version and digest; a continuation refreshes a changed cited document; unresolved references are named in the prompt; unrelated unreferenced documents stay absent |
| 6 | Project plan set, stale set, a lane that lists none of the project's repositories, a new lane | Order saved and versioned; stale and non-listing refused; a new lane joins the end |
| 7 | Promote an approved brief-bearing lead, and a papercut, to a task | One task each; papercut brief has a `queue_approval` naming its promoter; lead or papercut promoted with the task as target; outcome `planningSource` names it; the papercut brief can be amended |
| 7a | Promote a papercut with no lanes in a saved plan, then one with assigned lanes | The first task joins the first eligible `now` lane; the second keeps its assigned lane |
| 8 | Promote retried or response lost | Same task, never a second |
| 8a | Agent CLI promotion with and without an authorization note; board promotion | With a note: approval recorded as relayed, naming the agent and the note; without: refused, nothing recorded; board: `operator (board)` |
| 8b | Lead listing two repositories: promote without naming one, then once per repository | Refused without a repository; then two linked tasks, one per repository, both in `targets` |
| 8c | Roll the service during a lead promotion before and after its atomic insert | On restart, absent source/task binding settles not delivered and a same-version retry creates one task; a committed binding settles to that task; a newly approved version uses a distinct promotion key |
| 9 | Promotion whose re-check fails | Refused; source still open; the fresh check recorded; no task |
| 10 | Brief-bearing lead versions: a failing version, approval, then a new version | The failing version can't be approved; approval binds to the passing version's digest; the new version clears it |
| 11 | Follow a lead to its merged outcome | Lead → task → outcome row links resolve through `lead.get`, task detail and `queue.outcome` |
| 12 | A card in two lanes, and finished or cancelled tasks | One card, counted once, keeping both lanes; no Done column, and finished or cancelled tasks absent; no switch, lane rows or lane chips (revision 2026-11-08) |
| 13 | A task in each phase, and an empty project selection | One row of columns, each card once; every phase lands in its column (Working, Attention, Review, Closing as mapped); no Status view; no selection shows all projects and a selection scopes them |
| 12a | A column with 300 cards | Every card in a full-height column that scrolls on its own, the header counting all 300; cards are the standard task card size |
| 14 | Planning tab edits: reorder, move between Now and Later, add a listed lane, save a lane document | Plan and document saved as operator versions with the horizon kept; stale save refused |
| 14a | Planning tab navigation at both viewport sizes | Plan and lane columns at the wide size; plan, lane drill-down with back at the compact size; the pipeline board has no side pane |
| 14c | Open the Nucleus board in a workspace of a project's repository, and in a workspace outside every project | Scoped to that project's Pipeline and Planning; outside every project, a plain message |
| 14d | Open a project row's chevron: Park asks first, Unpark, Rename in place with an empty, 201-character, refused or valid name (Save, Enter, Cancel, Escape), Remove from Nucleus, Escape | One row's panel opens at a time, attached to its row; Rename replaces the label with the input and keeps the draft after a refusal; each save uses the project's version and refreshes the board; Remove leaves the picker for the shared removal dialog with its blockers; Escape cancels an open action before the picker; the row's selection and counts are unchanged by disclosure or a re-sorting rename |
| 14b | Click one project, Shift-click a second, Shift-click the first off, then Clear or Shift-clear the last one | A plain click replaces the selection and a Shift-click toggles one project, so every task and planning view shows first one project, then both (Planning shows both plans), then the second alone; an empty selection means all projects, and Clear (beside Settings, or alone on a host without it) or Shift-clearing the last project restores them while the picker stays open |
| 15 | Board dark theme at both viewport sizes, with a busy board | Legible; checked after merge by the Nucleus Chatterbox |
| 15a | Click a lead card and a papercut card on the Pipeline view; run each modal action | The modal opens with the record's full detail; the cards show no buttons; each action works from the modal and reports its result there; inapplicable actions are disabled with the reason |
| 15b | Open a checked, approved lead, then a new version of it; open a lead from Triage and from a lane with more than eight open leads | The brief sits beside its checked version and approval, which names the approver and any relayed authority; Check, Approve and Promote each report their own result or refusal; the new version shows the check and approval as out of date and asks for the existing recheck; drop, reopen and question or knowledge promotion sit in More actions with their reasons; raw ids and every version stay behind Details; the lane's lead list pages eight at a time with its true total |
| 16 | Restart and migration | Records, versions, plans and links survive; old stores migrate with none |
| 17 | Reopen a dropped lead (`lead.reopen`), then repeat it, reopen an open or promoted lead or a papercut, and export the result | The lead is `open` again with id, content version, versions, checks, approval, author, membership and targets unchanged, no new version, and one `reopens` episode keeping the reopen reason, actor and prior drop; repeats and wrong states refuse with nothing written; the export reads `open` truthfully with no `reopens` field |

## Out of scope

Lane gating or dependencies, knowledge files (they stay in repositories), editing
records other than leads, lane documents and plans from the board, and deleting a
repository's `docs/plan.md` (the Chatterbox does that after each import).

## Release-line admission authority (Tom, 2026-10-08)

Tom approved a bounded Nucleus admission change for the urgent Project-g v0.5.2
release line (decision fc8fd91d). Leads must be able to select a pushed integration
branch explicitly while keeping main as the default. Changing that base requires
a new checked version and approval; it must never reuse main approval or replace
main with a released tree. Normal independent review, exact PR-base/head checks,
merge and QA remain required. This authorization covers Nucleus admission, not
release tags, publication or duplicate Project-g release tasks. QA and hosted CI
must be assessed on the actual release branch; main evidence does not transfer.

## Registered main and release-base routing (Tom, 2026-10-08)

The release admission authorized by decision fc8fd91d includes real dispatch and
post-merge synchronization. A Nucleus-held brief with a non-main base can keep its
registered clean checkout on main. Nucleus temporarily attaches a private linked
checkout to the selected local base for dispatch validation and fast-forward sync,
then removes it without force. A failed-add outcome is reconciled against Git
registration before directory removal; registered or unreadable outcomes stay
preserved for the owner. Only that base is advanced to its pushed origin head; main is
never switched or merged with the release tree. Planning ancestry, pinned brief,
PR base, exact-head independent review and merge proofs remain required. Git
refuses a base already owned by another worktree. Dirty or changed main, a
diverged release ref and pause before synchronization refuse without replacing
local work. Same-base checkout behavior is unchanged. Integration-writing closeout
authorities still require their selected-base checkout; this routing does not grant those hooks permission to write main.

Private checkout add and no-force remove run under the bounded slow-Git ceiling
(`GIT_SLOW_TIMEOUT_MS`, 600 s), not the 30-second read gate, because linked
population of a large base can outlast 30 seconds. Tom's standing Nucleus reliability
authority and Project-a's 2026-10-12 checkout recovery request authorize only this
budget and its diagnostics. Every failed command's message names its budget and elapsed time; its fields keep
Node's raw `killed` witness beside the timeout, exit code or signal the process
actually reported; output
is the last few lines with URL credentials redacted. A timeout is witnessed only by
Node's kill flag, never inferred from progress. A checkout cleanup that refuses
to remove a registered or uncertain root raises `IntegrationCheckoutCleanupError`:
the refusal is its `cause`, the earlier operation failure its `operationError`,
and both messages are kept, so a timeout's or exit's evidence is not lost. Budget changes do not relax branch, dirty, diverged, race or
partial-registration guards, and nothing is retried, forced, pruned or reused.
Project-a#3295 (a8cbfbf7) failed before workspace, worker, intent, run or PR creation
while `git worktree add` populated about 38,578 files and stopped near 86 %
with no fatal text retained. The exact historical exit code and signal were not
kept; a timeout is plausible, not proven. Its orphan or registration state was
confirmed absent, and no cleanup, kill or reset was performed. Retrying it is
a later operator-owned pre-dispatch step after frozen refs and ownership are proved.


The same private selected-base routing applies to the clean synchronized base
proof used by prospective-merge and project-validation gates, including later
base rechecks. Verification does not advance the selected ref or skip its origin
comparison. Manifest discovery, candidate ownership and hook events retain the
registered repository identity. A release brief with no manifest still proves
its selected base before returning no hook; it never requires main to switch.
Tom authorized this completion of decision fc8fd91d on 2026-10-08 for Project-g
#151. Candidate QA, independent exact-head approval and release authority stay
separate; this correction grants no consumer retry or merge authority.


Selected-base routing also covers forge's pre-merge integration-base proof and
read-only closeout publication verification (Tom's #151 follow-through under
fc8fd91d, 2026-10-08). They use the same private checkout and preserve the
registered main identity. The pre-merge base must still equal origin; closeout
must still match the synchronized/merged ancestry and any reported publication
commit, admit only canonical Markdown changes and finish clean/pushed. Post-merge
synchronization was already routed through the helper. No hook write authority,
consumer retry, merge, candidate-proof or release authority is added.


## Bounded board lead reads

The board's planning lists (Pipeline Triage cards, Planning and the
project selector) read the internal `lead.board` projection in one revisioned
response. Its cards carry list metadata, a body preview bounded to the first
400 characters, and the target, check, approval, tag, repository and lane facts
the cards show; bodies, approval notes, versions, reopens and promoted history
stay out. Cards are the open leads plus the promoted leads that still have a
draft or task target and a repository without one — exactly the records the
Pipeline projection displays — so the response cannot grow with promoted
history. A promoted lead outside that set appears only as `{id, lanes,
repositories}` link facts when an open decision links it, keeping decision
lanes and scoping intact. The projection is rebuilt when a lead, papercut or
decision write advances its own planning-list revision, and reused between
writes (the rule itself is owned by
[the service boundary](../contracts/service-boundary.md), "Responsiveness", which
keys the planning list on its own revision). Opening
a record still reads the complete body, approval and history through
`lead.get`. Fixture measurement (2026-10-20,
`evidence/triage-load-board-read.json` in Git history): 17 requests and 13.8 MB through the
former page walk became one request and 7.1 KB; installed-UI confirmation is a
separate rolled-bundle check.

`lead.list` stays the documented full-body read with unchanged input, output
and bounds: `pageSize: 8` and then `before: {createdAt, id}` from the returned
`next` cursor. Paged reads order by creation timestamp and ID descending, apply
repository/lane/state filters before the limit, and retain each full body and
its approval metadata. An explicit null `next` ends the read. Pages preserve
the stored timestamp string, including legacy formats, and sort equal
timestamps by ID rather than the unpaged row-ID tie-break. Leads inserted
before the cursor appear on the next refresh; this is a live read, not an
immutable snapshot. Failure to advance or a failed page rejects the whole read
rather than presenting a partial list. Each paged response is `{items, next}`;
its records normally have an 8 MiB serialized UTF-8 budget. A larger single
record is returned alone if it fits 16 MiB minus 64 KiB of envelope headroom.
These budgets include escaped strings, Unicode, bodies and metadata. A
byte-shortened page retains a continuation cursor. Only a record exceeding the
transport budget refuses explicitly rather than being silently omitted. The
prior unpaged operator interface still returns its complete array, and
`lead.get` continues to return the full selected lead.

Paging avoids a backlog's combined brief bodies exceeding Paseo's 16 MiB RPC
response limit without increasing that limit, truncating briefs, or changing
approval or promotion authority. The board no longer needs that walk for its
lists, and no agent or skill is asked to switch to `lead.board`.

## Revision: board reads follow the store revision (2026-11-09)

Leads, open decisions and plans use the board revision as their client query key,
with a five-minute stale time instead of full-payload interval polling. Lead,
decision and plan writes advance that revision; successful board writes refresh
the snapshot immediately and invalidate the affected lists. Failed reads remain
visible and retryable.

The board and decision pills share the open-decision read, including an in-flight
request for the same revision. Composer contributions share one agent inventory
subscription; native questions follow its updates and reconnect snapshots instead
of refreshing every agent. Hosts without a subscription retain inventory polling.
A refresh that omits pending permissions retains the last authoritative question
state; only explicit permission data or agent removal clears it.
Capacity settings read on entry and after a write, and pool autosave invalidates
only the board state and profile catalogue.

## Revision: board reads follow their own domain revision (2026-11-10)

Tom (2026-11-10): the triage list flashed empty every few seconds, and keying it on
the store revision refetched lists that change a few times an hour on every run
event, telemetry write or observation.

This supersedes the query key in the 2026-11-09 revision. Leads, open decisions and
plans key on their own revision from the board's `planning` field
([service boundary](../contracts/service-boundary.md)), so an unrelated board
revision refetches none of them. The decision pills and the board share the
decision read under the same `decisions` key. Each list keeps its previous result
on screen while a new revision loads; a failed refresh keeps the last loaded list
and says it was not refreshed, and loading or error states show only with no list
to show. A write the operator makes moves its domain revision, so it shows at once.

## Revision: automatic lead and papercut triage (nucleus#1420, 2026-11-20)

Tom's direction: a project planner should not have to remember to sweep its
open leads and papercuts. Nucleus wakes the project's planner with a bounded
triage batch when records change, when a deferred record comes due, or when
dispatch room opens. Filing text stays evidence; the planner decides.

**Opt-in, per project.** Triage is off until a project opts in with
`triage.set` (`{project, enabled, by}`). Opting out keeps the ledger, so a later
opt-in resumes it. Nucleus itself is the pilot; activation is the planner's
call once this lands, and nothing in code enables it.

**Ledger.** Each project's state is one durable meta row, `triage:<project>`,
so assessments, the outstanding batch and the last completed batch survive a
daemon roll and a planner handover. It holds, per record: a versioned history
of settled dispositions, the source digest the decision rests on, and the
record's next condition (a deferred revisit time). The digest covers the lead
version, title, body, lanes, tags, state and base branch, so an edit or a
lane move makes the record eligible again.

**Batches.** Eligible records are open, not tagged `hold` (an intentional hold
is never triaged automatically), and either unassessed, changed since their
decision, or deferred past their revisit time. The oldest eligible records come
first, at most eight to a batch. A project holds at most one outstanding batch;
records that change while it is outstanding wait for the next one. The sweep
evaluates at most once a minute.

- A planner-less project keeps the batch visible in Planning and `triage.get`, unnoticed,
  until a planner is registered. A handover ends the old planner's prompt and
  addresses the batch to the new planner.
- A full dispatch queue (live tasks at the project's slot limit) holds batch
  creation with `waiting: capacity` until room opens. A batch is not made to
  queue promotions nobody can dispatch.
- The prompt is one durable notice, kind `triage`, delivered through the
  ordinary notice path to the project's responsible planner. It is live only
  while its batch is the project's outstanding batch, so a settled or replaced
  batch is never resent.

**Dispositions.** `triage.apply` (`{project, batch, by, decisions}`) takes one
decision per record:

| Disposition | Required | Effect |
| --- | --- | --- |
| `promote` | `reason` | Checks the brief if needed, approves the current version with `by` as approver, then promotes it with `by` as promoting agent through the ordinary operations. A papercut promotes through `papercut.promote-task`. A record already linked to a task settles without another promotion. |
| `close` | `reason`, `closure` (`duplicate`, `fixed` or `out_of_scope`), `canonical` | Drops a lead with the closure, reason and canonical target as its drop reason, or closes a papercut as `deprecated` (duplicate) or `completed` (fixed, out of scope), with the same text as its note. The filing text is kept. |
| `defer` | `reason`, `revisitAt` (a future ISO time) | Records the reason and the time. The record stays open and is eligible again when the time is due. |
| `operator` | `reason`, `question` | Records the question for the operator, shown as `operatorQuestions` in `triage.get`. The record stays open. |

`out_of_scope` closure needs `canonical` to name the plan rule that supports it.
Otherwise an out-of-scope idea stays deferred.

**Stale and replayed work.** An apply is accepted only for the outstanding batch.
A decision is applied only when its `leadVersion` and `digest` still match the
record and the record is still open. A changed record is superseded and never
closed or promoted on the old assessment. A replay of a completed batch returns
its recorded outcomes and changes nothing. A promotion that is not yet current
(a brief check running, an operation accepted, backpressure) is proposed, the
item stays open, and the planner applies again. Promotion is idempotent by
source, so a retry never dispatches twice. A refused decision (missing
evidence, a wrong or changed record) leaves its record open for a corrected
decision.

**Standing planner authority.** Promotion through triage uses the planner's
standing authority for routine, in-scope work only. Each promotion records the
planner as approver and promoting agent, with its reason, and runs the same
check and promotion gates as an operator-approved lead. Changes to product
direction, release or outward actions, and held profiles are not triage
decisions: the planner uses `operator` for them.

**Limits.** Triage never prunes on age, never edits filing text, and never
overrides a project's dispatch limit, pause or dispatch hold. Opting out or
pausing the service stops new batches; an outstanding batch keeps its record of
what was decided.

**Planning.** The project roadmap shows a digest of the current and last
completed batches. Open a batch to see proposed and applied outcomes, their
reasons, canonical targets, revisit times, operator questions and links to
recorded tasks. The batched `queue.plans` read refreshes when triage changes.
Use `triage.get` for the source version and digest needed by `triage.apply`.
