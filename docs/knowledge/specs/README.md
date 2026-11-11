# Specs

Detailed design for Nucleus: how each capability behaves, its edge cases and its
acceptance oracle. A spec stays the owner of its design after it is
implemented; the contracts summarise the durable rules and link here.

| Spec | Status |
| --- | --- |
| [001 — Generic repository hooks](001-generic-repository-hooks.md) | implemented |
| [002 — Durable hook retry and isolated integration writes](002-durable-hook-retry-and-isolated-writes.md) | implemented; isolated integration writes to be retired (R5) |
| [003 — Post-dispatch task disposition](003-post-dispatch-task-disposition.md) | implemented |
| [004 — Trusted host hook runners](004-trusted-host-hook-runners.md) | retired 2026-11-08; hooks name host tools without an approval registry |
| [005 — Nucleus lifecycle telemetry](005-queue-telemetry.md) | implemented |
| [006 — Terminal closeout projection convergence](006-terminal-closeout-projection-convergence.md) | implemented |
| [007 — Reviewed-head pre-merge hooks](007-reviewed-head-pre-merge-hooks.md) | implemented |
| [008 — Bounded worker checkpoint continuation](008-bounded-worker-checkpoint-continuation.md) | implemented |
| [009 — Shared telemetry snapshot and metric repair](009-shared-telemetry-snapshot-and-metric-repair.md) | implemented |
| [010 — Automatic exact-identity hook replay](010-automatic-exact-identity-hook-replay.md) | implemented |
| [011 — Reviewer calibration telemetry](011-reviewer-calibration-telemetry.md) | implemented |
| [012 — Durable asynchronous Nucleus operations](012-durable-asynchronous-operations.md) | implemented |
| [013 — Standalone Nucleus service and thin Paseo bridge](013-standalone-queue-service.md) | implemented |
| [015 — Prospective-merge pre-merge hooks](015-prospective-merge-pre-merge-hooks.md) | implemented |
| [016 — Live evidence before a recovery decision](016-live-evidence-before-recovery.md) | implemented |
| [017 — Review entry for externally authored PRs](017-external-pr-review-entry.md) | implemented |
| [018 — Nucleus-owned closeout and durable outcomes](018-queue-owned-closeout-and-durable-outcomes.md) | implemented |
| [019 — Lanes](019-lanes.md) | implemented |
| [020 — Briefs stored in Nucleus](020-briefs-stored-in-queue.md) | implemented |
| [021 — Task numbers](021-task-numbers.md) | implemented |
| [022 — Nucleus projects without manifests](022-queue-projects-without-manifests.md) | implemented |
| [024 — Papercuts in Nucleus](024-papercuts.md) | implemented |
| [025 — Outcome query](025-outcome-query.md) | implemented |
| [026 — Planning records in Nucleus](026-planning-records.md) | implemented |
| [027 — Multi-repository projects](027-multi-repository-projects.md) | implemented |
| [028 — Fresh sibling checkouts](028-fresh-sibling-checkouts.md) | implemented |
| [028 — Store backups](028-store-backups.md) | implemented |
| [030 — Changing a task's routing](030-routing-changes.md) | implemented |
| [032 — Operator decisions](032-operator-decisions.md) | implemented |
| [033 — Formal PR reviews under a separate reviewer identity](033-formal-pr-reviews.md) | implemented |
| [035 — Host run scheduler (Nucleus's side)](035-host-run-scheduler.md) | implemented; Effigy v2 custody protocol approved, not implemented |
| [036 — Operator role reassignment after worker intent](036-role-reassignment.md) | implemented |
| [037 — Structured review findings](retired/037-structured-review-verdicts.md) | retired 2026-11-02 (Spec 058 cutover 2); verdicts stay ordinary reviewer evidence |
| [038 — Bounded uncertain-merge reconciliation](038-bounded-uncertain-merge-reconciliation.md) | implemented |
| [040 — Merge hold owners and release prompts](040-merge-hold-release-prompts.md) | implemented |
| [041 — Planning roadmap and lane close-out](041-planning-roadmap.md) | implemented |

| [045 — Durable task worker exclusions](045-durable-worker-exclusions.md) | implemented |
| [046 — Self-lifting merge holds](046-self-lifting-merge-holds.md) | implemented |
| [050 — Owner task controls](050-owner-task-controls.md) | implemented |
| [051 — Interactive tasks](051-interactive-tasks.md) | implemented |
| [052 — Usage level](052-usage-level.md) | implemented |
| [053 — Demand-based profile selection](053-demand-based-selection.md) | implemented |
| [054 — Required proof when a repository overrides validation policy](054-required-proof-admission.md) | implemented |
| [055 — Source-immutable author-side proof execution](055-source-immutable-proof-executor.md) | implemented |
| [056 — Repository namespace re-key](056-repository-namespace-rekey.md) | implemented |
| [057 — Retained change review and source approval awaiting proof](057-retained-change-review.md) | approved, not implemented |
| [058 — Responsible tasks](058-responsible-tasks.md) | slices 1–17 installed (usage shadow, opt-in lifecycle, task.register, operator questions, live conversion, delegated answers, ask-in-turn, non-delivery ownership, review-round cap, one worker thread, the blocker ladder); rollout step 3 remainder and step 4 pending |
| [059 — Subscription usage pressure gauge](059-usage-gauge.md) | implemented: readers, samples, projection and `usage.state`, plus the Usage page and Paseo sidebar rail |
| [060 — Named project agents](060-named-project-agents.md) | implemented |

## Host adapters

The [T3Code host adapter](t3code-host-adapter.md) provides native thread operations
for the nightly trial, with CLI-helper reporting, board questions and per-project
host opt-in.

## Retired specs

| Spec | Status |
| --- | --- |
| [031 — Heavy-validation budget (Nucleus side)](retired/031-heavy-validation-budget.md) | retired 2026-10-02; replaced by 035 at migration step (c) |
| [023 — Brief drafts](retired/023-brief-drafts.md) | retired 2026-09-27; folded into leads (Spec 026) |
| [042 — Project owner threads and dormant projects](retired/042-project-owners.md) | retired 2026-11-02 (Spec 058 cutover 5); owner records stay readable, notices follow the planner |
| [043 — Declared review stages](retired/043-declared-review-stages.md) | retired 2026-10-06; kept as the historical evidence contract |
| [014 — Inspected stopped-revision head recovery](retired/014-inspected-stopped-revision-head-recovery.md) | retired 2026-10-14; the owner verbs settle stopped revisions |
| [039 — Operator re-review after an insufficient approval](retired/039-operator-rereview.md) | retired 2026-10-15; `move to=review` supersedes re-review, and external owner revisions retired 2026-11-02 |
| [044 — Saved reviewer progress](retired/044-reviewer-checkpoint-continuation.md) | retired 2026-10-14; checkpoints stay saved evidence, continuation is the owner verbs |
| [047 — Merged-task retention reconciliation at the integration base](retired/047-merged-task-retention-reconciliation.md) | retired 2026-10-14; covered by `retry_effect` |
| [048 — Owner completion of an accepted report without a PR](retired/048-owner-report-completion.md) | retired 2026-10-14; replaced by the Spec 050 `complete` verb |
| [049 — Evidence-based reconcile-and-continue recovery](retired/049-reconcile-and-continue.md) | retired 2026-10-14; the one reconciler and the owner verbs replaced it |
| [029 — Portable records](retired/029-portable-records.md) | retired 2026-10-31 (R3); export/import removed, old exports stay inert history |
| [034 — Shadow-run stream producer](retired/034-shadow-run-stream.md) | retired 2026-10-31 (R3); producer removed, written files and rows stay inert history |
