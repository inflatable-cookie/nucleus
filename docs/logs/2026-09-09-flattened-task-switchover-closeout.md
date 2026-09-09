# Flattened Northstar Task Switchover Closeout

Date: 2026-09-09
Status: closed
Task: `bca6d816-ae73-41d7-b20e-f2bf6be9863f`
Handoff: `../handoffs/20260909-140500-flattened-task-switchover.md`
Planning commit: `1b7724e4b5755bbd3d33b6d05d30189340055d9e`
PR: `https://github.com/inflatable-cookie/nucleus/pull/8`

## Outcome

The one-time Northstar lifecycle migration completed through the reviewed PR
loop. PR #8 merged on 2026-09-09 as
`4b001fe1c2d3013cf956dc4682ef58f89254c7ba`; local `main` is synchronized to
that commit.

Historic generations `g01`–`g04` were classified safely closed and compacted
into `roadmaps/archive/g01.md` through `archive/g04.md`. Their expanded trees
were removed only after preservation and link reconciliation: 2,052 historic
paths in total (`g01` 313, `g02` 721, `g03` 738, `g04` 280). The roll-ups retain
intent, durable destinations, retained risks, deferred items, and selected
evidence.

The active `g05` generation now has one executable task file per `g05.NNN`,
with tasks `001`–`027` unique and filename-matched. Milestone wrappers and the
active `batch-cards/` tree are gone. The absorbed live gates remain on their
own task surfaces, and `g05.027` owns the pending operator checkpoint.

The fix round removed the legacy batch-card template, repointed current
references into compacted generations, and replaced retired batch-card
vocabulary in live planning and instruction surfaces. The closed `dispatch.md`
ledger, logs, and historical handoffs retain their original terminology by
deliberate disposition.

## Acceptance And Review

- Worker head `120ee4430981b4ec4822963844b74c54fcb3529c` was reviewed at the
  exact head by an independent reviewer.
- Review comment `5602848283` returned `ready_to_merge` with the authenticated
  exact-head marker and resolved all three required findings.
- Queue verification accepted the canonical authorization, worker/reviewer
  independence, review evidence, and merge prerequisites before the plugin
  verified the merge and synchronized `main`.

## Validation

The accepted review and closeout checks recorded these passing results:

- `effigy qa:docs`
- `effigy qa:docs:links`
- `effigy qa:northstar`
- `git diff --check`

The closeout did not run the full product `effigy qa` board; this was a
documentation-only migration and no product, release, workflow, or provider
surface was changed.

## Deferred And Retained

- `g05.027` remains paused until the operator selects and runs the real-project
  orchestration checkpoint. Its contract-033 promotion decision remains open.
- `g05.016` remote transport remains paused behind a pairing/session contract;
  `g05.017` remains conditional-paused pending a concrete secondary-window
  workflow. `g06` remains proposed and was not selected.
- Review noted two pre-existing unresolved path conventions in
  `long-term-plan.md`; they predate this migration and remain outside its
  bounded scope.
- No new planning direction was inferred. The canonical next pointer remains
  `g05.027` in `docs/roadmaps/README.md`.

## References

- Preservation and old-to-new migration evidence: the merged PR and its
  review comment.
- Historic roll-ups: `../roadmaps/archive/g01.md` through `archive/g04.md`.
- Active roadmap and frontier: `../roadmaps/README.md` and `../roadmaps/g05/README.md`.
