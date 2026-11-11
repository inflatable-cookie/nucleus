# 025 — Outcome query

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042 item 4b, [Spec 018](018-queue-owned-closeout-and-durable-outcomes.md)
(the outcome record, 4a), [Spec 019](019-lanes.md) (lanes), [Spec 021](021-task-numbers.md)
(task references). Nucleus ports the query with the outcome table.

## Problem

Lean repositories keep no delivery log, and Spec 018 made Nucleus's outcome table
the only record of what landed. It holds 2,369 permanent rows across 37
repositories (2,276 backfilled). But `queue.outcome` returns one row by exact
identity: task id, submission id or `repo#N`. Nobody can ask the question the log
used to answer: "what landed for X, and in which PR?" Without that, an agent
reconstructs history from `git log` and PR searches, and loses the why that only
the brief and review hold.

## Query

A new read-only `queue.outcome-search` RPC and CLI method. Every filter is
optional, and filters combine with AND.

| Filter | Matches |
| --- | --- |
| `repository` | Normalised origin, or a path resolving to one (the identity used by outcomes, lanes and numbers) |
| `text` | Full-text search over title, brief text, review summary and reason |
| `lane` | Lane key |
| `outcome` | `done`, `cancelled` or `superseded`; default `done` |
| `since`, `until` | `finishedAt` bounds (ISO dates) |
| `commit` | A hex prefix of at least 7 characters matching the merge commit, synced commit or reviewed PR head |
| `pr` | PR number, within `repository` |

- **Results** are compact rows, newest `finishedAt` first. Each has the reference,
  title, repository, outcome, lane, PR number and URL, merge commit, finish time,
  whether it was backfilled, and for a text search a short highlighted excerpt
  saying where it matched. Brief text is never returned in bulk; the full row
  stays one `queue.outcome` call away.
- **Paging**: `limit` defaults to 20, with a maximum of 100. A stable cursor on
  (`finishedAt`, `taskId`) continues the list. The response carries the cursor
  and whether more rows exist.
- **Commit lookup** joins code to intent. `git log -- path` names the commits that
  changed a file, and `commit` names the task, brief and review behind each one.
  Nucleus does not index files or diffs; Git already does.
- **Superseded tasks** name their replacement, so following a chain takes one
  more lookup.

## Index

- A SQLite FTS5 table over title, brief text, review summary and reason, keyed by
  task id, with the porter tokenizer. It is written in the same transaction as
  the outcome row, so a row is searchable as soon as it exists.
- The migration builds the index for existing rows in one pass (11 MB of JSON
  today). A task purged before Spec 018 has no outcome row and stays absent.
- Structured filters read indexed columns (repository, lane, outcome,
  `finishedAt`, merge commit and PR number) added to `outcomes` by the same
  migration. They are not parsed from JSON on every query.
- The outcome row stays the source of truth: the index can be rebuilt from it,
  and nothing reads the index for anything but search.

## Surfaces

- **RPC and CLI**: `outcome-search` through `node bin/queue-cli.mjs`, with the
  payload shape documented in the README and the nucleus skill.
- **Skill wording**: the skill says to answer "what landed for X", "why does this
  code look like this" and "did we already try Y" with `outcome-search` (and
  `commit` after `git log`) before reading PRs. It says that a repository keeps
  no delivery log.
- **Responsiveness**: a search runs on the executor like other reads, and must
  meet the Spec 012 read budget (p95 100 ms of Nucleus CPU time) on the live-size store. It is
  bounded by `limit`, and never scans brief text outside FTS.

## Search index storage

Schema 55 uses an external-content FTS index keyed by the permanent outcome rowid.
A view supplies the searchable fields and snippets from the outcome JSON; triggers
keep the index current when a row changes. Rebuilding the index retains the same
search and pagination behavior without another copy of the text.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Search by repository, lane, outcome and date range | Only matching rows, newest first; default `done` |
| 2 | Text search over title, brief, review summary and reason | Matching rows with an excerpt naming the field; stemmed matches found |
| 3 | `commit` with a 7-character prefix of a merge commit, synced commit or PR head | That task; a shorter prefix refused |
| 4 | `pr` with `repository` | That task; `pr` without `repository` refused |
| 5 | Paging across 250 rows with equal `finishedAt` values | Every row exactly once, in stable order |
| 6 | A new terminal task | Searchable in the same transaction that writes its outcome row |
| 7 | Migration on a store with existing and backfilled rows | Index and columns built; row count and content unchanged; restart keeps them |
| 8 | Superseded task | Row names `replacementTaskId` |
| 9 | Live-size copied store | Search p95 within the Spec 012 read budget, as a `timingTest` |
| 10 | Results never include brief text | Only the excerpt; full text through `queue.outcome` |

## Out of scope

A board view of history, semantic or vector search, indexing files or diffs,
searching live tasks (the board and `queue.snapshot` cover those), and editing
outcome rows.
