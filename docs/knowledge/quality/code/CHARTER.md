# Nucleus product-code module rating: charter (2026-11-13)

## Why
Tom, 2026-11-13: "can we do an architecture and code quality review of nucleus - I want you to rate all of
the features / modules out of 10, put them all in a list, then we can judge a good level target to aim
for? It's worked well for effigy". This sweep produces the table, and it mirrors Effigy's code-rating
charter so the two are comparable. Tom and the planner set the target after seeing it. Nothing changes in
this sweep.

## Hard constraints
- **Snapshot:** judge Nucleus main at exactly `136cf0de71a7675a6bf9bbe89bb3cf7cb7b8c5d9`. Raters read a
  detached, read-only checkout at that commit. Cite `path:line` at that commit.
- **Read only:** no source edits, commits, PRs, Nucleus tasks or messages to other agents. Don't run test
  suites, builds or `effigy`. You may read code, list tests, and use `git log`, `git blame` and `rg`.
- **Write** only your own two files: the domain's table and report.

## Unit
A module is one TypeScript source file, or a tight file group with one responsibility (for example a
small directory whose files only serve each other). Product code only: `core/`, `service/`, `hosts/`,
`shared/`, `client/`, `bin/`. Exclude `test/`, test support, generated files and `.d.ts`/`.d.mts`
declarations. Rate every product file in your domain: each file belongs to exactly one row.

## Score: 0–10, the sum of five parts
| Part | Range | Question |
|---|---|---|
| **O**wnership | 0–2 | Is this the single owner of its mechanism (2), or one of several places doing the same thing (0)? Name the duplicates. |
| **T**yped facts | 0–2 | Does it decode facts once into types and let callers decide (2), or re-derive them from strings, labels, regexes over messages or debug text (0)? |
| **F**ailure | 0–2 | Does it fail closed where the contract requires, keep unknown distinct from absent or false, and give errors that say what to do (2)? Or does it fail open, swallow errors (`catch {}`) or lose state (0)? |
| **P**roportion | 0–2 | Is its size and branching proportionate to its job (2), or has it piled up flags, special cases, retries and patch layers (0)? Use churn and `git log` as evidence. |
| **Pr**oof | 0–2 | How well do tests cover it? Find tests in `test/` that import it (directly or via its owner) and judge whether they assert behaviour and outcomes at the module's real boundary (2), are thin, shape-only or source-text matching (1), or are absent (0). |

**Action:** `keep`, `simplify` (say what), `consolidate` (with which module), `harden` (which failure
path), `split` (along what seam), or `delete` (dead or vestigial; say how you know: no callers via `rg`).

## Nucleus-specific things to watch
These are this codebase's known recurring defect classes from 2026-11-11 to 11-13. Judge whether each
module is exposed to them:
- **Wrong-host calls:** host calls not routed to the task's or agent's own host.
- **String-keyed facts:** labels read under the wrong key, refusals parsed from message text, choice
  labels matched by prefix.
- **Silent failure:** `catch {}`, success returned for an unapplied effect, unknown delivery treated as
  absent.
- **Unbounded work on shared paths:** synchronous filesystem work on the executor, reads waiting on
  host calls, unbounded child output.
- **Patch layers:** many single-incident special cases, guard flags and "legacy" branches.
- **Duplicated decisions:** the same rule implemented in `next` and in the verb, or in several copies.

## Objective columns (computed, not judged)
`loc` (non-blank lines), `churn30` and `churn90` (commits touching the file in the last 30 and 90 days at
the snapshot), and `fixes` (commits in 90 days whose subject mentions fix, repair, stuck, refuse, wedge,
loop or regression). Compute these with `git log` in the tree.

## Evidence rules
- Any O = 0, `consolidate` or `delete` needs `path:line` for the duplicate, or proof of no callers.
- Any T or F of 1 or less needs `path:line` for the offending code.
- Mark inference as inference. Judge the code as it is at the snapshot.

## Output
1. `<DOMAIN>.csv` with header
   `module,files,loc,churn30,churn90,fixes,O,T,F,P,Pr,score,action,reason,evidence`:
   - `module`: a repo-relative path, or a group name;
   - `files`: `;`-separated;
   - `reason`: one line, ending in a `path:line` citation for the mechanism it describes;
   - `evidence`: `;`-separated `path:line` references.
2. a `<DOMAIN>.md` report, at most two pages:
   - the score distribution (count per score 0–10) and the mean;
   - the 15 lowest modules, one line each;
   - consolidation clusters (modules that should become one owner);
   - dead-code candidates;
   - the most exposed modules for each recurring defect class above;
   - coverage notes: files rated, anything skipped and why.
