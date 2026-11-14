# Code-module quality tables

The product-code ratings: 588 modules in `N1.csv`–`N6.csv` (N1 orchestration 96, N2 task lifecycle
81, N3 state and planning 57, N4 machine and workspaces 104, N5 service and hosts 78, N6 shared and
client 172), rated at commit `136cf0de` on 2026-11-13. The method is in [CHARTER.md](CHARTER.md).
Calibration, distribution, recurring defect classes and the target are in [SUMMARY.md](SUMMARY.md).

**Target (Tom, 2026-11-14):** floor 5 now, then 6, then 7.

## Columns

| Column | Meaning |
|---|---|
| `module` | Repo-relative path, or a group name for a tight file group. |
| `files` | The files the row covers, `;`-separated. Each product file belongs to exactly one row. |
| `loc` | Non-blank lines at the rated commit. |
| `churn30` / `churn90` / `fixes` | Commits touching the files in 30 and 90 days, and fix-like commits in 90 days, at the rated commit. |
| `O` `T` `F` `P` `Pr` | Ownership, Typed facts, Failure, Proportion and Proof, each 0–2. |
| `score` | The sum, 0–10. |
| `action` / `reason` / `evidence` | Disposition (`keep`, `simplify`, `consolidate`, `harden`, `split` or `delete`), its one-line reason, and `path:line` evidence at the rated commit. |

## Re-rating

A PR that splits, consolidates or deletes a rated module updates its rows here. It removes or replaces
the old row, adds a row per new module with the charter's five parts and evidence at the PR head, and
notes the commit. Scores are never edited without a re-rate. Code that has moved since `136cf0de` keeps
its old row until its module is next changed.

## Re-rates

- nucleus#1199 (floor 5, 2026-11-14): `core/store/store.ts`, `core/store/store-tasks.ts` and
  `core/store/store-maintenance.ts` were split into one owner per mechanism; `store-maintenance.ts` no
  longer exists. The store rows in `N3.csv` were re-rated at that PR's head.
