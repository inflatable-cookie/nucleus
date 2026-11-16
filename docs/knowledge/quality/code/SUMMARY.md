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

## Calibration of the re-rates (2026-11-16)

**Result.** A blind pass over **60 re-rated rows** gives a mean of **8.32**, against **8.70** given:
**−0.38 points** (blind minus given). **54/60 (90%)** agree within ±1. Differences are −3:1, −2:5,
−1:20, 0:24, +1:10. One blind score is below 7; its follow-up candidate is listed below. No existing
score in `N1.csv`–`N6.csv` changed.

**Snapshot and blindness.** This pass applies the five-part [charter](CHARTER.md) to main at
`28e21da5b236304191adf9acea2a0df6fea86283`, replacing the original sweep's snapshot and write constraints
for this docs-only calibration. Source and behavioral test assertions were read before the given
scores, reasons or PR discussions. A selector read rating history privately and exposed only module
identity, files, domain, round and size. All 60 scores, actions and evidence were committed in
`b148d9c60` before comparison; the later CSV change fills only `given`. Product source is unchanged at
this PR's head, so its `path:line` citations apply there too.

**Selection.** At that snapshot, 126 current rows crossed at least one of floors 5–7 in an upward
numeric re-rate after `136cf0de`. The initial table publication is excluded. Assign each row to the
lowest floor it crossed in that history: 5 before 6 before 7, even if it crossed another floor later. This gives distinct historical
round strata; it does not claim that their current scores are 5 or 6.

Take ten rows per domain: three from floor 5, three from floor 6 and four from floor 7. N3 has only
two eligible floor-6 rows, so its spare place goes to floor 5. In each of these 18 strata, take the
largest current module first (module-name order breaks ties). Fill the remaining places without
replacement by ascending `-ln(u)/w`, where:

- `u = (int(SHA256("nucleus-1263-calibration-2026-11:" + domain + ":" + module), 16) + 1) / (2^256 + 1)`;
- `w = ln(1 + loc) × 3` for a given score of exactly 7, otherwise `ln(1 + loc)`.

Thus size and exactly-7 scores receive extra selection weight without exposing them to the rater.
The realized sample includes six exactly-7 rows out of 16 eligible, all 18 stratum maxima, and
22,406 non-blank lines. Median module size is 302 lines, versus 231.5 in the eligible pool. These
purposive and weighted choices make the figures sample comparisons, not population estimates or a
certificate for all 894 current rows.

| Domain | Eligible | Sample: floor 5 / 6 / 7 | Given mean | Blind mean | Blind − given | Within ±1 |
|---|---:|---:|---:|---:|---:|---:|
| N1 orchestration | 18 | 3 / 3 / 4 | 8.80 | 8.40 | −0.40 | 10/10 |
| N2 task lifecycle | 28 | 3 / 3 / 4 | 8.50 | 8.30 | −0.20 | 9/10 |
| N3 state and planning | 13 | 4 / 2 / 4 | 8.80 | 8.10 | −0.70 | 8/10 |
| N4 machine and workspaces | 29 | 3 / 3 / 4 | 8.30 | 8.10 | −0.20 | 9/10 |
| N5 service and hosts | 14 | 3 / 3 / 4 | 8.80 | 8.00 | −0.80 | 8/10 |
| N6 shared and client | 24 | 3 / 3 / 4 | 9.00 | 9.00 | 0.00 | 10/10 |

By historical crossing round: floor 5 has 19 rows, mean difference −0.42 and 18/19 within ±1;
floor 6 has 17, −0.71 and 14/17; floor 7 has 24, −0.13 and 22/24. The earlier calibration was
+0.50 with 73% within ±1. This pass is slightly stricter on average; neither sample supports a
uniform score correction.

**Below-7 candidate — complete list (one row).** `service/runtime-owner.ts`: **given 8, blind 6**
(`O=2, T=1, F=1, P=0, Pr=2`). PR-state read failure publishes an empty map at
`service/runtime-owner.ts:709`; retention-summary failure becomes null at
`service/runtime-owner.ts:1043`; host conflict is inferred from `startError` text at
`service/runtime-owner.ts:1062`. The 1,543 non-blank-line owner combines bootstrap, refresh and health
with RPC controls, including `service/runtime-owner.ts:1283`; its 30/90-day churn is 35 commits.
Candidate for a planner-chosen follow-up: separate bootstrap/refresh/health from RPC controls and
preserve unknown read outcomes and typed host-conflict facts. The table's existing 8 remains intact.

**Ledger.** [calibration-2026-11.csv](calibration-2026-11.csv) retains the table columns plus `given`
and `blind`; `score` equals the sum of the blind `O,T,F,P,Pr` parts and equals `blind`. Each reason
names its domain, historical crossing commit, all five judgments and a source citation; evidence
also names the inspected test boundary. LOC and churn/fix counts are recomputed at the snapshot
(one commit counted once across grouped files; case-insensitive `fix|repair|stuck|refuse|wedge|loop|regression`
in subjects for fixes). The pre-comparison CSV SHA-256 is
`372acadb7a4eec6e5e872af3866360434cbffeceae5a8c953bb0096c46047aac`.
