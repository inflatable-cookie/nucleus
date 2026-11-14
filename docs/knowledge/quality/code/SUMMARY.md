# Nucleus code ratings: summary (2026-11-13, snapshot 136cf0de)

**Method.** Effigy's code-rating charter adapted to TypeScript (`CHARTER.md`). Five parts of 0–2 each:
Ownership, Typed facts, Failure, Proportion and Proof. Six Opus raters, one per domain (N1–N6), read-only on
a frozen tree. Then one blind Opus calibrator re-scored a stratified sample of 66 modules without seeing
the original scores.

**Coverage.** 588 rows, about 127k non-blank lines. Every product file under `core/`, `service/`,
`hosts/`, `shared/`, `client/` and `bin/`, excluding declarations. Per-domain tables: `N1.csv`–`N6.csv` beside
this file.

## Scores (raw, kept as the table)

| Domain | Rows | Mean | Line-weighted |
|---|---|---|---|
| N1 orchestration | 96 | 7.38 | 6.40 |
| N2 task lifecycle | 81 | 6.85 | 5.77 |
| N3 state and planning | 57 | 7.21 | 6.00 |
| N4 machine and workspaces | 104 | 7.22 | 6.20 |
| N5 service and hosts | 78 | 7.49 | 6.45 |
| N6 shared and client | 172 | 8.03 | 7.30 |
| **All** | **588** | **7.47** | **6.41** |

Distribution: 2:2, 3:9, 4:24, 5:40, 6:79, 7:111, 8:144, 9:130, 10:49.

How far each floor is from today: below 5, 35 rows (18% of lines); below 6, 75 (32%); below 7, 154 (51%);
below 8, 265 (67%).

## Calibration

The blind calibrator averaged 7.79 on the sample, against the raters' 7.29 (+0.50). 48 of 66 rows (73%)
agree within ±1. Per domain (blind minus rater): N1 −0.55, N2 +1.20, N3 +0.88, N4 +1.42, N5 +0.60,
N6 −0.20. Large modules (300+ lines) differ least (+0.35), so the low-scoring hubs are low under either
rater. There's no uniform correction: per-domain samples (about 10 each) are too small, and the raters
were, if anything, strict. Read scores as ±1. The ranking, and the set of hubs at 4 or below, is robust.

## What the low end is

The 35 rows at 4 or below are mostly the central hubs:
- `planning/operations.ts` and `store/store-tasks.ts`;
- `store/store.ts` and `store-maintenance.ts`;
- `hooks/hooks.ts`;
- `recovery/recovery.ts` and `worker-failover.ts`;
- `questions/ladder.ts` and `questions.ts`;
- `intake/callback-intake.ts` and `result-application.ts`;
- `closeout/workspace-lifecycle.ts`;
- `dispatch/dispatch.ts` and `run-launch/thread.ts`;
- `merge/check-waits.ts`;
- the Paseo bridge and the T3 adapter;
- `qa/project-qa-supervisor.ts`;
- `machine/host-process-reap.ts` and `process-group.ts`;
- `git/index.ts`;
- `client/project-editor.tsx` and `settings-screen.tsx`.

Most are `split`.

## Recurring defect classes (cross-domain)

- **Facts read from text:** decisions drawn from `task.reason`, error messages, event detail and prompt
  wording. This is the most common defect in merge, dispatch, recovery and questions. Examples:
  `shared/task-stop.ts`, about 13 regexes; `core/qa/proof-only-go.ts`, which matches a reviewer prompt.
- **One rule, many copies:**
  - the agent-idle check, about 45 times, and the copies disagree (a helper already exists at
    `core/intake/run-settlement.ts:76`);
  - raw-SQL availability reads, more than 20;
  - "repository by origin, else path", about 20;
  - "retry if main moved", 4 copies with limits of 3, 3, 2 and 3;
  - the "no eligible profile" regex, 5 copies;
  - two host contracts, `core/host/adapter.ts` and `shared/host.ts`.
- **Wrong-host defaults:**
  - `engine.ts` and `resolution.ts` default host checks to "available";
  - `shared/host-kind.ts` treats any unknown host as Paseo;
  - `ladder.ts` archives deciders without routing to their host.
- **Silent failure:** `catch {}`, unknown treated as absent (`request-ledger.ts:148` reports
  "not received"), and success reported for unapplied effects.
- **Unbounded work on shared paths:** synchronous `git` and `ps` on the executor, uncapped child output,
  and a pointer-file scan every 2 s.
- **Dead code:** 10 `delete` rows, including the legacy `bin/` helpers, `repository-archive-gate.ts`,
  `profile-import.ts` and `question-caller.mjs`.

## Live defects found and briefed

nucleus#1186 (critical):
- the admission gate merges different messages to the same agent and drops the later one;
- an owner restart resends a notify after a failed send.

## Target (Tom, 2026-11-14)

Tom: "Go with recommendations". **Floor 5 now**, then floor 6, then floor 7 (Effigy's floor) as the
longer-term target. Round 1 briefs every row below 5 as split or consolidate tasks grouped by domain.
A module's row is re-rated in the PR that changes it.

### Options that were offered

- **A. Floor 5 next** (35 rows, 18% of lines, the hubs). Splitting and consolidating these removes most
  recurring defect classes at their source.
- **B. Floor 6** (75 rows, 32%).
- **C. Floor 7** (154 rows, 51%), Effigy's test floor, as the longer-term target. A mean of 8.5 would be a
  later stretch goal.
