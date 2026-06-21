# g03 Effect-Gated SCM Execution

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Turn the completed g02 SCM planning chain into stopped-by-default execution
gates, then continue through adapter-neutral and Convergence-like publication
proofs without pretending Git workflow semantics are universal.

G03 starts with Git because g02 selected Git as the first executable adapter
lane from evidence. It then continues into the adapter-neutral and
Convergence-like work that should have stayed in the same generation. This
generation does not grant broad SCM, forge, provider, callback, interruption,
recovery, or raw-output authority. Each effect must be admitted, persisted,
and diagnosed separately before a runner can execute it.

## Generation Runway

Current generation goal:

- prove change-request execution paths from adapter plan to explicit execution
  authority, command planning, sanitized evidence, operator review, and
  stopped-by-default runner boundaries without collapsing provider-specific
  SCM semantics into a false universal model

Current runway bands:

- Git change-request execution authority records
- Git command descriptor and request planning
- Git branch/worktree execution preflight
- Git commit/push/PR authority separation
- adapter-neutral change-request chain projection and persistence
- Convergence-like publication admission, preflight, descriptors, request
  persistence, runner proof, and evidence persistence
- read-only diagnostics and control DTOs for every effect gate
- stopped runner command-adapter boundary before any real Convergence backend
  integration
- Convergence backend surface research before any real runner effect
- storage-backed Convergence stopped runner replay before real backend effects
- local Convergence snap admission before remote publication effects
- stopped local Convergence snap command requests before process execution
- persisted local snap stopped requests before runner execution
- stopped local snap runner proof and sanitized evidence before real execution
- persisted local snap runner evidence before a stopped command adapter
- stopped local snap command adapter before any runner execution
- persisted local snap runner replay before real command execution
- local snap execution preflight before process spawn
- stopped local snap spawn requests before real process spawn
- stopped local snap spawn handoff before process runner invocation
- sanitized local snap spawn receipts before raw process output
- read-only local snap spawn receipt control before any process runner surface
- Convergence exit summary before selecting a non-Convergence lane
- post-Convergence health and boundary rebaseline before another effect lane
- control envelope request/query split before another provider effect lane
- durable live provider smoke command-runner split as health-only work
- SCM capture dry-run execution persistence split as health-only work
- durable executor dispatch selection split as health-only work
- Codex callback request persistence split as health-only work
- durable dispatch invocation preflight split as health-only work
- runtime observation event-store persistence split as health-only work
- completion SCM capture preparation persistence split as health-only work
- SCM capture dry-run persistence split as health-only work
- turn-start executor smoke boundary split as health-only work

Current checkpoint:

- g02 closed with adapter-specific plan records, Git-like plans,
  convergence-like plans, and adapter-plan diagnostics
- Git execution proof is represented through pull-request execution admission
- adapter-neutral chain and Convergence-like publication records are folded
  into g03 as milestones 010-034
- doctor remains red on known god-file pressure
- next ready card is turn-start executor smoke boundary type split
- Convergence receipt control is complete, Convergence backend effects are
  deferred, and the next active lane is not Convergence-specific
- control envelope request/query/protocol split is complete and removed one
  doctor error
- durable live provider smoke command-runner split is complete and removed one
  doctor error without enabling provider writes
- next active lane is health-only turn-start executor smoke boundary splitting,
  not an SCM mutation or provider write lane

## Convergence Exit Criteria

Minimum remaining Convergence work:

- record which Convergence effects remain intentionally deferred
- preserve the current adapter boundary as a stopped proof, not a real runner
- select a non-Convergence next lane from implementation evidence

Explicitly deferred until Convergence itself is stable enough to integrate:

- actual `converge snap` process execution
- raw stdout/stderr retention
- object upload
- publication creation
- lane-head sync
- bundle creation, approval, promotion, release, or resolution publication
- Convergence-specific recovery, cancellation, or retry execution

After the exit summary, do not add another Convergence milestone unless the
operator explicitly reopens Convergence work.

Selected non-Convergence next lane:

- post-Convergence health and boundary rebaseline

Reason:

- the Convergence proof now has enough stopped surfaces for current planning
- additional Convergence work would depend on an unfinished upstream system
- the server/provider front door and god-file pressure should be checked before
  another provider, SCM, or UI lane grows the codebase

## Milestones

- `001-git-change-request-execution-gate.md` - completed
- `002-git-change-request-dry-run-runner.md` - completed
- `003-git-branch-worktree-admission.md` - completed
- `004-git-branch-worktree-execution-handoff.md` - completed
- `005-git-commit-admission.md` - completed
- `006-git-push-admission.md` - completed
- `007-forge-pull-request-descriptor-dry-run.md` - completed
- `008-forge-pull-request-execution-admission.md` - completed
- `009-git-change-request-execution-closeout.md` - completed
- `010-adapter-neutral-change-request-chain-projection.md` - completed
- `011-adapter-neutral-chain-persistence-control.md` - completed
- `012-convergence-publication-admission.md` - completed
- `013-convergence-publication-command-boundary.md` - completed
- `014-convergence-publication-request-persistence.md` - completed
- `015-convergence-publication-runner-proof.md` - completed
- `016-g03-health-validation-rebaseline.md` - completed
- `017-server-provider-front-door-consolidation.md` - completed
- `018-convergence-runner-evidence-persistence.md` - completed
- `019-convergence-stopped-runner-command-adapter.md` - completed
- `020-convergence-backend-surface-research.md` - completed
- `021-convergence-runner-replay-boundary.md` - completed
- `022-convergence-local-snap-admission.md` - completed
- `023-convergence-local-snap-command-boundary.md` - completed
- `024-convergence-local-snap-request-persistence.md` - completed
- `025-convergence-local-snap-runner-proof.md` - completed
- `026-convergence-local-snap-runner-evidence-persistence.md` - completed
- `027-convergence-local-snap-stopped-runner-command-adapter.md` - completed
- `028-convergence-local-snap-runner-replay-boundary.md` - completed
- `029-convergence-local-snap-execution-preflight.md` - completed
- `030-convergence-local-snap-spawn-request-boundary.md` - completed
- `031-convergence-local-snap-spawn-handoff-boundary.md` - completed
- `032-convergence-local-snap-spawn-receipt-boundary.md` - completed
- `033-convergence-local-snap-spawn-receipt-control.md` - completed
- `034-convergence-exit-and-next-lane-selection.md` - completed
- `035-post-convergence-health-and-boundary-rebaseline.md` - completed
- `036-control-envelope-request-boundary-split.md` - completed
- `037-durable-live-provider-smoke-command-runner-split.md` - completed
- `038-scm-capture-dry-run-execution-persistence-split.md` - completed
- `039-durable-executor-dispatch-selection-split.md` - completed
- `040-codex-callback-request-persistence-split.md` - completed
- `041-durable-dispatch-invocation-preflight-split.md` - completed
- `042-runtime-observation-event-store-persistence-split.md` - completed
- `043-completion-scm-capture-preparation-persistence-split.md` - completed
- `044-scm-capture-dry-run-persistence-split.md` - completed
- `045-turn-start-executor-smoke-boundary-split.md` - active

## Batch Cards

Ready cards:

- `batch-cards/148-turn-start-executor-smoke-boundary-type-split.md`

Paused cards:

None.

Planned cards:

- `batch-cards/149-turn-start-executor-smoke-boundary-helper-test-split.md`
- `batch-cards/150-turn-start-executor-smoke-boundary-validation-closeout.md`

Completed cards:

- `batch-cards/001-git-change-request-execution-authority-records.md`
- `batch-cards/002-git-change-request-command-descriptors.md`
- `batch-cards/003-git-change-request-command-request-records.md`
- `batch-cards/004-git-change-request-preflight-records.md`
- `batch-cards/005-git-change-request-diagnostics.md`
- `batch-cards/006-git-change-request-authority-closeout.md`
- `batch-cards/007-git-change-request-dry-run-handoff.md`
- `batch-cards/008-git-change-request-dry-run-sanitized-outcomes.md`
- `batch-cards/009-git-change-request-dry-run-evidence.md`
- `batch-cards/010-git-change-request-dry-run-diagnostics.md`
- `batch-cards/011-git-change-request-dry-run-closeout.md`
- `batch-cards/012-git-branch-worktree-admission-records.md`
- `batch-cards/013-git-branch-worktree-command-descriptors.md`
- `batch-cards/014-git-branch-worktree-preflight-records.md`
- `batch-cards/015-git-branch-worktree-diagnostics.md`
- `batch-cards/016-git-branch-worktree-closeout.md`
- `batch-cards/017-git-branch-worktree-execution-handoff.md`
- `batch-cards/018-git-branch-worktree-sanitized-outcomes.md`
- `batch-cards/019-git-branch-worktree-evidence.md`
- `batch-cards/020-git-branch-worktree-execution-diagnostics.md`
- `batch-cards/021-git-branch-worktree-execution-closeout.md`
- `batch-cards/022-git-commit-admission-records.md`
- `batch-cards/023-git-commit-command-descriptors.md`
- `batch-cards/024-git-commit-preflight-records.md`
- `batch-cards/025-git-commit-diagnostics.md`
- `batch-cards/026-git-commit-admission-closeout.md`
- `batch-cards/027-git-push-admission-records.md`
- `batch-cards/028-git-push-command-descriptors.md`
- `batch-cards/029-git-push-preflight-records.md`
- `batch-cards/030-git-push-diagnostics.md`
- `batch-cards/031-git-push-admission-closeout.md`
- `batch-cards/032-forge-pull-request-descriptor-records.md`
- `batch-cards/033-forge-pull-request-dry-run-evidence.md`
- `batch-cards/034-forge-pull-request-diagnostics.md`
- `batch-cards/035-forge-pull-request-descriptor-closeout.md`
- `batch-cards/036-forge-pull-request-execution-admission-records.md`
- `batch-cards/037-forge-pull-request-execution-preflight.md`
- `batch-cards/038-forge-pull-request-execution-diagnostics.md`
- `batch-cards/039-forge-pull-request-execution-closeout.md`
- `batch-cards/040-git-change-request-execution-chain-summary.md`
- `batch-cards/041-git-change-request-next-adapter-selection.md`
- `batch-cards/042-g03-closeout-validation.md`
- `batch-cards/043-adapter-neutral-chain-projection-records.md`
- `batch-cards/044-adapter-neutral-chain-diagnostics.md`
- `batch-cards/045-adapter-neutral-chain-closeout.md`
- `batch-cards/046-adapter-neutral-chain-persistence-records.md`
- `batch-cards/047-adapter-neutral-chain-control-dto.md`
- `batch-cards/048-adapter-neutral-chain-persistence-closeout.md`
- `batch-cards/049-convergence-publication-admission-records.md`
- `batch-cards/050-convergence-publication-preflight-diagnostics.md`
- `batch-cards/051-convergence-publication-closeout.md`
- `batch-cards/052-convergence-publication-command-descriptors.md`
- `batch-cards/053-convergence-publication-stopped-requests.md`
- `batch-cards/054-convergence-publication-command-closeout.md`
- `batch-cards/055-convergence-publication-request-persistence.md`
- `batch-cards/056-convergence-publication-request-control-dto.md`
- `batch-cards/057-convergence-publication-request-persistence-closeout.md`
- `batch-cards/058-convergence-publication-runner-proof-records.md`
- `batch-cards/059-convergence-publication-runner-evidence.md`
- `batch-cards/060-convergence-publication-runner-closeout.md`
- `batch-cards/061-g03-validation-rebaseline.md`
- `batch-cards/062-server-module-export-pressure-review.md`
- `batch-cards/063-g03-next-lane-selection.md`
- `batch-cards/064-server-provider-front-door-consolidation-plan.md`
- `batch-cards/065-server-provider-front-door-module-grouping.md`
- `batch-cards/066-server-provider-front-door-closeout.md`
- `batch-cards/067-convergence-runner-evidence-persistence.md`
- `batch-cards/068-convergence-runner-evidence-control-dto.md`
- `batch-cards/069-convergence-runner-evidence-persistence-closeout.md`
- `batch-cards/070-convergence-stopped-runner-command-adapter.md`
- `batch-cards/071-convergence-stopped-runner-command-diagnostics.md`
- `batch-cards/072-convergence-stopped-runner-command-closeout.md`
- `batch-cards/073-convergence-backend-surface-research.md`
- `batch-cards/074-convergence-runner-backend-contract.md`
- `batch-cards/075-convergence-backend-research-closeout.md`
- `batch-cards/076-convergence-runner-replay-records.md`
- `batch-cards/077-convergence-runner-replay-diagnostics.md`
- `batch-cards/078-convergence-runner-replay-closeout.md`
- `batch-cards/079-convergence-local-snap-admission-records.md`
- `batch-cards/080-convergence-local-snap-admission-diagnostics.md`
- `batch-cards/081-convergence-local-snap-admission-closeout.md`
- `batch-cards/082-convergence-local-snap-command-descriptors.md`
- `batch-cards/083-convergence-local-snap-stopped-requests.md`
- `batch-cards/084-convergence-local-snap-command-closeout.md`
- `batch-cards/085-convergence-local-snap-request-persistence.md`
- `batch-cards/086-convergence-local-snap-request-control-dto.md`
- `batch-cards/087-convergence-local-snap-request-persistence-closeout.md`
- `batch-cards/088-convergence-local-snap-runner-proof-records.md`
- `batch-cards/089-convergence-local-snap-runner-evidence.md`
- `batch-cards/090-convergence-local-snap-runner-proof-closeout.md`
- `batch-cards/091-convergence-local-snap-runner-evidence-persistence.md`
- `batch-cards/092-convergence-local-snap-runner-evidence-control-dto.md`
- `batch-cards/093-convergence-local-snap-runner-evidence-persistence-closeout.md`
- `batch-cards/094-convergence-local-snap-stopped-runner-command-adapter.md`
- `batch-cards/095-convergence-local-snap-stopped-runner-command-diagnostics.md`
- `batch-cards/096-convergence-local-snap-stopped-runner-command-closeout.md`
- `batch-cards/097-convergence-local-snap-runner-replay-records.md`
- `batch-cards/098-convergence-local-snap-runner-replay-diagnostics.md`
- `batch-cards/099-convergence-local-snap-runner-replay-closeout.md`
- `batch-cards/100-convergence-local-snap-execution-preflight-records.md`
- `batch-cards/101-convergence-local-snap-execution-preflight-diagnostics.md`
- `batch-cards/102-convergence-local-snap-execution-preflight-closeout.md`
- `batch-cards/103-convergence-local-snap-spawn-request-records.md`
- `batch-cards/104-convergence-local-snap-spawn-request-diagnostics.md`
- `batch-cards/105-convergence-local-snap-spawn-request-closeout.md`
- `batch-cards/106-convergence-local-snap-spawn-handoff-records.md`
- `batch-cards/107-convergence-local-snap-spawn-handoff-diagnostics.md`
- `batch-cards/108-convergence-local-snap-spawn-handoff-closeout.md`
- `batch-cards/109-convergence-local-snap-spawn-receipt-records.md`
- `batch-cards/110-convergence-local-snap-spawn-receipt-diagnostics.md`
- `batch-cards/111-convergence-local-snap-spawn-receipt-closeout.md`
- `batch-cards/112-convergence-local-snap-spawn-receipt-control-dto.md`
- `batch-cards/113-convergence-local-snap-spawn-receipt-control-diagnostics.md`
- `batch-cards/114-convergence-local-snap-spawn-receipt-control-closeout.md`
- `batch-cards/115-convergence-deferred-effects-summary.md`
- `batch-cards/116-convergence-exit-control-closeout.md`
- `batch-cards/117-next-non-convergence-lane-selection.md`
- `batch-cards/118-post-convergence-health-evidence-refresh.md`
- `batch-cards/119-server-provider-boundary-pressure-audit.md`
- `batch-cards/120-next-engine-boundary-migration-selection.md`
- `batch-cards/121-control-envelope-request-query-module-split.md`
- `batch-cards/122-control-envelope-protocol-helper-split.md`
- `batch-cards/123-control-envelope-boundary-validation-closeout.md`
- `batch-cards/124-durable-live-provider-smoke-model-split.md`
- `batch-cards/125-durable-live-provider-smoke-helpers-split.md`
- `batch-cards/126-durable-live-provider-smoke-validation-closeout.md`
- `batch-cards/127-scm-capture-dry-run-execution-persistence-record-split.md`
- `batch-cards/128-scm-capture-dry-run-execution-persistence-helper-split.md`
- `batch-cards/129-scm-capture-dry-run-execution-persistence-validation-closeout.md`
- `batch-cards/130-durable-executor-dispatch-selection-type-split.md`
- `batch-cards/131-durable-executor-dispatch-selection-blocker-test-split.md`
- `batch-cards/132-durable-executor-dispatch-selection-validation-closeout.md`
- `batch-cards/133-codex-callback-request-persistence-type-split.md`
- `batch-cards/134-codex-callback-request-persistence-helper-test-split.md`
- `batch-cards/135-codex-callback-request-persistence-validation-closeout.md`
- `batch-cards/136-durable-dispatch-invocation-preflight-type-split.md`
- `batch-cards/137-durable-dispatch-invocation-preflight-helper-test-split.md`
- `batch-cards/138-durable-dispatch-invocation-preflight-validation-closeout.md`
- `batch-cards/139-runtime-observation-event-store-persistence-type-split.md`
- `batch-cards/140-runtime-observation-event-store-persistence-helper-test-split.md`
- `batch-cards/141-runtime-observation-event-store-persistence-validation-closeout.md`
- `batch-cards/142-completion-scm-capture-preparation-persistence-type-split.md`
- `batch-cards/143-completion-scm-capture-preparation-persistence-helper-test-split.md`
- `batch-cards/144-completion-scm-capture-preparation-persistence-validation-closeout.md`
- `batch-cards/145-scm-capture-dry-run-persistence-type-split.md`
- `batch-cards/146-scm-capture-dry-run-persistence-helper-test-split.md`
- `batch-cards/147-scm-capture-dry-run-persistence-validation-closeout.md`

## Planned Runway Sequence

1. Git change-request execution gate - completed
2. Git change-request dry-run command runner - completed
3. Git branch/worktree creation admission - completed
4. Git branch/worktree execution handoff - completed
5. Git commit creation admission - completed
6. Git push admission - completed
7. Forge pull-request descriptor and dry-run evidence - completed
8. Forge pull-request execution admission - completed
9. Git change-request execution closeout and next adapter selection - completed
10. Adapter-neutral chain projection and persistence - completed
11. Convergence publication admission through runner evidence persistence -
    completed
12. Stopped Convergence runner command-adapter proof - completed
13. Convergence backend surface research - completed
14. Convergence runner replay boundary - completed
15. Convergence local snap admission - completed
16. Convergence local snap command boundary - completed
17. Convergence local snap request persistence - completed
18. Convergence local snap runner proof - completed
19. Convergence local snap runner evidence persistence - completed
20. Convergence local snap stopped runner command adapter - completed
21. Convergence local snap runner replay boundary - completed
22. Convergence local snap execution preflight - completed
23. Convergence local snap spawn request boundary - completed
24. Convergence local snap spawn handoff boundary - completed
25. Convergence local snap spawn receipt boundary - completed
26. Convergence local snap spawn receipt control - completed
27. Convergence exit and next non-Convergence lane selection - completed
28. Post-Convergence health and boundary rebaseline - completed
29. Control envelope request boundary split - completed
30. Durable live provider smoke command-runner split - completed
31. SCM capture dry-run execution persistence split - completed
32. Durable executor dispatch selection split - completed
33. Codex callback request persistence split - completed
34. Durable dispatch invocation preflight split - completed
35. Runtime observation event-store persistence split - completed
36. Completion SCM capture preparation persistence split - completed
37. SCM capture dry-run persistence split - completed
38. Turn-start executor smoke boundary split - active
