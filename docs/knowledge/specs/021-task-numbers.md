# 021 — Task numbers

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042,
[Spec 018 durable outcomes](018-queue-owned-closeout-and-durable-outcomes.md)

## Problem

Lean Northstar dropped roadmaps, and with them the `g05.217`-style numbers people
used to talk about work. Nucleus task ids are UUIDs. Tom asked for a human-friendly
number that Nucleus assigns and keeps.

## Decisions

- **Per repository**, like GitHub issue numbers (Tom, 2026-09-26). Numbers start
  at 1 for each repository and are never reused, including for cancelled, removed
  or purged tasks.
- **Displayed as `#N`** where the repository is obvious (a project-filtered board,
  a task's own detail), and as `repo#N` where it is not (All projects, notices,
  cross-project lanes, CLI output). `repo` is the origin repository name, for
  example `consumer-b-v2#304`.
- **Zero-filled to at least three digits** wherever a number is shown as text
  (`004`, `049`, `1631`): references, board labels, workspace titles, prompts and
  PR titles (Tom, 2026-09-26). Storage stays an integer, and lookups accept a
  reference with or without the leading zeros (`repo#4` or `repo#004`).
- **Repository identity** is the normalised origin (`owner/name`), falling back
  to the canonical checkout path when a repository has no origin. This is the same
  identity the outcome record uses.

## Assignment

- Assigned in the same transaction that creates the task: submission (handoff or
  brief), review entry. A dry run or refused submission assigns
  nothing. A replayed submission with the same submission id returns the existing
  task and its number.
- Numbers live in a permanent `task_numbers` table (task id, repository, number,
  unique per repository) with a per-repository counter. The table is never
  purged. It is separate from the outcome row, which is never rewritten, and it
  is joined on read.
- **Backfill.** On migration, every task still in the store is numbered per
  repository in creation order. Purged tasks, which survive only as tombstones or
  outcome rows, get none.

## Where the number appears

- **Submission response and operation status:** the result carries `number` and
  `reference` (`repo#N`), next to the task id.
- **Task records:** snapshot, board summaries, `queue.detail` and the outcome row
  as read.
- **Lookup:** `queue.detail` and `queue.outcome` also accept
  `{ "reference": "repo#N" }`, or `{ "repository": "owner/name", "number": N }`.
- **Workspace title:** `<State>: <N> <title>`, for example `Working: 304 Legacy
  video triage`, with no repository prefix: the host already shows the repository
  (Paseo groups workspaces by project in its sidebar; Tom, 2026-09-26). A held or
  waiting task with no work due shows its target (`Waiting on #248` or `Waiting on
  Tom`) or its holder role (`Held by planner`). A ready merge hold reads `Merge
  held by <holder>`; active work keeps its phase label. Worker blocks without a
  holder and other actionable faults keep their phase label. For blocked and
  needs-attention tasks, a live dispatch or merge fence is the current stop; its
  reason and owner supply the target or holder label. A changed computed label
  refreshes the existing workspace title even when phase and held status stay
  the same. The title stays current as the task moves and remains
  plain text, with nothing host-specific.
- **Board:** cards and detail show `#N`, or `repo#N` when All projects is
  selected or the lane spans repositories.
- **Worker prompt:** names the task's number and asks for the PR title to start
  with it as a bare number, for example `304: Legacy video triage`. On GitHub `#N`
  is the repository's own issue and PR numbering and is autolinked, so a Nucleus
  number written as `#304` or `repo#304` there would point at an unrelated PR.
- **Branch names are unchanged** (`ns-<task id>`). Workspace and branch identity
  checks parse that exact slug, and the number gains nothing there.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | First accepted task in a repository | Number 1; later tasks count up |
| 2 | Two repositories | Independent sequences; `repo#N` distinguishes them |
| 3 | Dry run, refused submission | No number assigned; the counter is unchanged |
| 4 | Replayed submission id | Same task, same number |
| 5 | Review entry | Numbered like submissions |
| 6 | Cancelled, removed and purged tasks | Numbers never reused; the reference still resolves after purge through the outcome row |
| 7 | Submission response and operation status | Carry `number` and `reference` |
| 8 | Lookup by reference and by repository and number | `queue.detail` and `queue.outcome` resolve it; an unknown reference is refused |
| 9 | Workspace title across phase changes and held waits | `<State>: <N> <title>`, with a linked wait target or holder when no work is due |
| 10 | Board, project-filtered and All projects | `#N` and `repo#N` respectively |
| 11 | Migration backfill | Existing tasks numbered per repository in creation order, stable across restart |
| 12 | Worker prompt | Carries the number and the bare-number PR-title instruction; otherwise unchanged |

## Out of scope

Renaming branches, renumbering, reserving or choosing numbers by hand, and
cross-repository numbering.
