# 024 — Papercuts in Nucleus

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042, [Spec 018](018-queue-owned-closeout-and-durable-outcomes.md)
(repository identity), [Spec 021](021-task-numbers.md) (task references).
Nucleus ports the table into its core.

**2026-09-28:** papercuts are stored as tagged leads, one table, with the `papercut.*`
interface retained (Tom), except the retired file importer. See Spec 026, "Revision: papercuts are tagged leads".
This spec still defines the papercut interface and its fields.

## Problem

Papercuts, the small bounded friction notes, live in each repository's
`PAPERCUTS.md` (34 root files, plus package copies in consumer-b), in varying
formats, and repositories are meant to hold knowledge and code, not process. Tom
decided that papercuts leave repositories: Nucleus holds them, and the files and
Effigy's papercuts machinery go.

## Record

Papercuts are permanent tagged leads, never purged and host-neutral:

| Field | Content |
| --- | --- |
| `id` | Nucleus identity |
| `repository` | Normalised origin plus local path hint (the identity used by outcomes, lanes and numbers) |
| `area` | Optional area or repository path the friction is about |
| `title` | Short summary |
| `happened` | What happened (the friction) |
| `impact` | Why it matters |
| `fix` | A plausible fix; optional |
| `filedBy`, `filedAt` | Agent id, `operator`, or `import`; original date when imported |
| `state` | `open`, `promoted` (with `taskId`) or `closed` (with `closedReason`: `completed` or `deprecated`, a note and `closedAt`) |
| `source` | For imported entries: file path, line and a content key |

Closed entries drop off the working list but stay queryable.

## Operations

RPC and CLI (`papercut.add`, `papercut.list`, `papercut.get`, `papercut.promote`,
`papercut.close`), documented in the Nucleus skill so planners
use them instead of editing `PAPERCUTS.md`.

- **List** by repository and state; the default is open.
- **Promote** links the papercut to a task, by id or `repo#N` reference. The task
  can come from any submission path. A promoted papercut leaves the open list. In
  this version, promotion does not open a brief draft itself; that follow-up comes
  once brief drafts (Spec 023) land.
- **Promote to task** resolves the same repository's registered project checkout,
  then its registered repository checkout, before using the filing path hint.
  Resolution happens at admission and again when the durable operation executes;
  archived worker worktrees therefore do not prevent promotion. The filing
  identity and provenance stay unchanged, and the normal Git origin and brief
  checks still apply. An existing task link is returned without another task.
- **Close** with a reason, `completed` or `deprecated`, and an optional note.
- **Merged task completion** automatically closes its promoted papercut as
  `completed`, recording the PR URL and merge commit in the note. The task and
  papercut updates commit together. Repeated closeout writes are idempotent;
  existing manual closures stay unchanged. Cancelled tasks and completion
  without a recorded merge leave the papercut promoted. This applies to the
  papercut interface and papercut-tagged lead promotion (Tom, 2026-10-07).

## Board

Papercuts are tagged leads in Pipeline Triage (Spec 026). Their cards open the
papercut detail modal, which shows the structured fields and linked task and
offers Promote and Close. The separate Papercuts tab and its state-filtered list
were retired on 2026-10-03 (Tom); agents can still use `papercut.list` to query
closed and promoted records.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Add, get and list by repository and state | Round-trip; open by default; closed and promoted leave the open list and stay queryable |
| 2 | Promote with a task id and with `repo#N` | Linked; state `promoted` |
| 3 | Close as completed and as deprecated | State `closed` with reason, note and time |
| 10 | Pipeline Papercut card and detail modal in dark theme at both viewport sizes | Filtered with the project selector; Promote and Close remain available; other pipeline output is unchanged |
| 11 | Restart and supported schema upgrade | Current papercuts and original evidence survive; stores below schema 50 require an older build first |
