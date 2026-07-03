# g03 Effect-Gated SCM Execution

Status: active
Owner: Tom
Updated: 2026-07-02

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
- turn-start stdio execution envelope split as health-only work
- stdio frame ingestion persistence split as health-only work
- durable executor dispatch admission split as health-only work
- doctor-green health closeout before selecting the next implementation lane
- explicit Git branch/worktree runner proof from existing stopped handoff
  records
- Git/forge runner health and boundary rebaseline before provider auth or
  forge network execution
- planning projection payloads, deterministic file export, capture prep, and
  publication/share gates before projection import/admission

Current checkpoint:

- g02 closed with adapter-specific plan records, Git-like plans,
  convergence-like plans, and adapter-plan diagnostics
- Git execution proof is represented through pull-request execution admission
- adapter-neutral chain and Convergence-like publication records are folded
  into g03 as milestones 010-034
- doctor exits cleanly with god-file findings reduced to warnings only
- Convergence receipt control is complete, Convergence backend effects are
  deferred, and the next active lane is not Convergence-specific
- control envelope request/query/protocol split is complete and removed one
  doctor error
- durable live provider smoke command-runner split is complete and removed one
  doctor error without enabling provider writes
- Git branch/worktree runner proof is complete through authority refresh,
  command adapter, sanitized outcome persistence, diagnostics, and read-only
  control DTOs.
- Git commit runner proof is complete through authority records, command
  adapter, sanitized outcome persistence, diagnostics, and read-only control
  DTOs.
- Git push runner proof is complete through authority records, command adapter,
  sanitized outcome persistence, diagnostics, and read-only control DTOs.
- stopped forge pull-request runner proof is complete through authority records,
  sanitized provider-request adapter, outcome persistence, diagnostics, and
  read-only control DTOs.
- Git/forge runner health and boundary rebaseline is complete; focused runner
  tests pass, doctor remains warning-only and error-free, and real provider-auth
  or network execution behavior remains contract-gated.
- Provider-auth and forge execution contract lane is complete. Contract `027`
  now owns credential refs, network-write admission, provider response
  evidence, idempotency, retry/recovery, and operator-review boundaries before
  any real provider writes.
- Stopped provider-auth and forge admission records are complete. The server
  now models credential refs, network authority refs, operator approval refs,
  idempotency keys, retry/recovery policy refs, and sanitization policy refs
  without resolving credentials or calling provider networks.
- Stopped forge network execution preflight/control records are complete. The
  server now models provider context refs, target provider refs,
  credential-use evidence refs, preflight evidence refs, and planned
  provider-response evidence refs without resolving credentials or calling
  provider networks.
- Stopped forge network execution request/receipt records are complete. The
  server now records stopped execution request ids, runtime receipt refs, retry
  lineage, and recovery classification refs from preflight state without
  resolving credentials or calling provider networks.
- Stopped forge network execution outcome persistence/control records are
  complete. The server now persists sanitized stopped outcomes, duplicate
  no-ops, blocked/repair-required outcome status, diagnostics, and read-only
  control counts from request/receipt records without resolving credentials,
  calling provider networks, or retaining raw provider payloads.
- Forge network stopped-runner health and boundary rebaseline is complete.
  Focused forge network and stopped PR runner tests pass, no direct
  network/process/provider execution tokens were found in the audited modules,
  and warning-sized file pressure remains documented as warning-only.
- Stopped provider credential-status refresh/control records are complete. The
  server now classifies credential refs into ready, repair, unknown, and
  unsupported buckets, reports sanitized control counts, and blocks credential
  material, provider payloads, real credential resolution, provider network
  calls, callbacks, interruption, recovery execution, task mutation, and raw
  provider payload retention.
- Stopped provider credential-status refresh persistence/control records are
  complete. The server now persists sanitized refresh records, duplicate
  no-ops, blocked persistence records, diagnostics, and read-only control
  counts without resolving credential material or calling provider networks.
- Provider-auth stopped-boundary health rebaseline is complete. Focused
  credential-status, forge network, and stopped PR runner tests pass, no direct
  network/process/provider execution tokens were found in the audited modules,
  and warning-sized file pressure remains documented as warning-only.
- Stopped provider repository metadata refresh/control records are complete.
  The server now records planned repository metadata refresh state from
  provider context refs, requires provider instance, forge provider, remote
  repo, credential-status evidence, repository-metadata evidence, and
  sanitization refs, and blocks credential material, provider payloads, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, task mutation, and raw provider payload retention.
- Stopped provider repository metadata refresh persistence/control records are
  complete. The server now persists sanitized repository metadata refresh
  records, duplicate no-ops, blocked persistence records, diagnostics, and
  read-only control counts without resolving credential material or calling
  provider networks.
- Stopped provider pull-request/merge-request refresh/control records are
  complete. The server now records planned pull-request or merge-request
  refresh state from provider context refs, requires refresh scope,
  credential-status evidence, repository-metadata evidence,
  pull-request-refresh evidence, and sanitization refs, and blocks credential
  material, provider payloads, real credential resolution, provider network
  calls, callbacks, interruption, recovery execution, task mutation, and raw
  provider payload retention.
- Stopped provider pull-request/merge-request refresh persistence/control
  records are complete. The server now persists sanitized PR/MR refresh
  records, duplicate no-ops, blocked persistence records, diagnostics, and
  read-only control counts without resolving credential material or calling
  provider networks.
- Provider-forge read-pattern consolidation is complete. Credential-status,
  repository-metadata, and PR/MR refresh now prove the stopped read-intent
  pattern; issue, comment, review workflow, and status/check refresh fan-out is
  paused until the reusable projection/control shape is promoted.
- Generic provider read-intent projection/control is complete. The server now
  projects persisted credential-status, repository-metadata, and PR/MR refresh
  records into one read-only aggregate surface with family counts, status
  counts, blocker counts, evidence counts, and no-effect flags.
- Provider read-intent query composition is complete. The server now composes
  the generic projection from local-store persisted credential-status,
  repository-metadata, and PR/MR refresh records through a read-only query
  result and control DTO.
- Provider read-intent control boundary is complete. The in-process server
  control handler can request the projection, while the serializable envelope
  still rejects it until a provider read-intent wire DTO contract is designed.
- Provider read-intent boundary rebaseline is complete. The next lane may add
  serialized control-envelope support, but only as a read-only aggregate/source
  count DTO with sanitized refs and no provider effects.
- Provider read-intent serialized control-envelope support is complete. Request
  DTOs can round-trip projection queries and response DTOs expose counts,
  source counts, sanitized entry refs, and explicit no-effect flags.
- Provider read-intent `nucleusd` query support is complete. The root Effigy
  task surface can inspect the read-only projection without provider effects.
- Provider read-intent Tauri IPC consumption is complete. The desktop command
  adapter can submit the serialized query and receive a sanitized read-only
  projection without provider effects.
- Provider read-intent product consumption decision is complete. The next
  product surface is a server-owned Provider Readiness Overview projection,
  not visible UI, live provider reads, or more read-family fan-out.
- Provider Readiness Overview projection is complete as a pure server
  projection over existing read-intent evidence. The next lane is read-only
  query/control integration, not visible UI.
- Provider Readiness Overview query/control integration is complete. The next
  lane is a `nucleusd`/Effigy inspection surface before any visible UI.
- Provider Readiness Overview `nucleusd`/Effigy inspection is complete. The
  next lane is Tauri IPC consumption of the same read-only overview, not a
  visible UI panel or provider effect.
- Provider Readiness Overview Tauri IPC consumption is complete. The next lane
  selects the product consumption path before any visible UI or provider
  effect.
- Provider Readiness Overview desktop proof surface and seeded evidence proof
  are complete. The desktop proof shell now consumes represented provider
  readiness data from local stopped evidence; the next lane is a read-only
  drilldown over the existing read-intent projection, not provider refresh.
- Provider Readiness Overview drilldown is complete. The desktop proof shell
  now reads the existing provider read-intent projection beside the overview;
  the next lane closes the provider-readiness product proof and selects the
  next provider lane deliberately.
- Provider Readiness product closeout is complete. The next provider lane is
  stopped status/check refresh because it supports task-completion evidence and
  PR review readiness without granting credential resolution, live provider
  refresh, provider effects, or raw payload retention.
- Stopped status/check refresh type/control is complete. The next slice persists
  sanitized status/check refresh records before projection or desktop seed
  integration.
- Stopped status/check refresh persistence is complete. The next slice folds the
  family into provider read-intent projection/query/DTOs and desktop seed proof
  without live provider behavior.
- Stopped status/check refresh projection/query/DTO integration and desktop
  seed proof are complete. Provider-readiness coverage now represents
  credential status, repository metadata, PR/MR, and status/check families.
- Provider-readiness coverage reassessment selected a fixture-backed live-read
  admission gate as the next lane. Issue/comment/review stopped refresh,
  credential repair, product UI hardening, and real provider reads remain
  deferred until this gate exists.
- Provider live-read admission gate is complete. Admission, preflight,
  sanitized request/receipt planning, persistence, diagnostics, and control
  DTOs are represented through fixture-backed records only. The next lane is
  live-read execution contract and adapter-boundary planning; real provider
  network calls, credential material resolution, provider writes, task
  mutation, callback/interruption/recovery execution, and raw payload retention
  remain blocked.
- Provider live-read execution contract and adapter boundary is complete.
  Credential lease metadata, provider capability records, stopped executor
  handoff records, fixture response/error records, and diagnostics are
  represented without credential material or provider I/O. The next lane is a
  stopped live-read smoke approval gate; real provider network calls still
  require explicit operator approval.
- Provider live-read smoke approval gate is complete. Smoke target,
  authority-checklist, and stopped smoke request records exist, but no live
  provider execution is authorized. The generation is paused at an operator
  approval checkpoint before the first real provider read smoke.
- The first approved live-read smoke completed manually through `gh` against
  `octocat/Hello-World` as a repository metadata refresh. It proved local
  provider read access with sanitized selected fields only, not a Nucleus-owned
  provider executor.
- Provider live-read smoke closeout selected a server-owned read-only executor
  as the next lane. The executor should wrap the same field-limited `gh repo
  view` path behind Nucleus-owned request, receipt, sanitization, and
  diagnostics records.
- Provider live-read server-owned executor is complete. It wraps the approved
  repository metadata read shape behind approved smoke-derived executor
  requests, a field-limited `gh repo view` descriptor, sanitized repository
  metadata records, receipts, and diagnostics without provider writes, task
  mutation, callback/interruption/recovery execution, credential material
  storage, or raw provider payload retention.
- The next lane is read-only executor control/query integration so the server
  can inspect executor diagnostics before any broader provider read fan-out or
  product UI hardening.
- Provider live-read executor control surface is complete. Server query
  vocabulary, serialized diagnostics DTOs, request-handler routing,
  `nucleusd query provider-live-read-executor`, and
  `effigy server:query:provider-live-read-executor` now inspect no-effect
  executor diagnostics without running a provider command.
- The next lane is a read-only command-runner handoff from ready descriptors to
  sanitized output/receipt mapping. It must remain explicit and operator-gated.
- Provider live-read command-runner handoff is complete. Ready handoff records
  can be built from field-limited descriptors, sanitized command output can map
  into repository metadata output and receipt records, and diagnostics cover
  ready, blocked, parse-error, mapped, and read-performed states without raw
  payload retention.
- Provider live-read command-runner smoke approval is complete. The approved
  read-only `gh repo view octocat/Hello-World` smoke succeeded with selected
  repository metadata fields only. No provider write, task mutation, callback,
  interruption/recovery execution, credential material storage, or raw payload
  retention occurred.
- The next lane is approved-smoke evidence promotion into server-owned
  executor records, not broader provider read fan-out or UI-triggered execution.
- Provider live-read status/check smoke and evidence promotion are complete.
  The provider lane is paused after reassessment; the next active lane is
  server/client workflow hardening and task/project workflow depth.
- Task timeline and project authority-map control parity is complete through
  serialized DTOs, `nucleusd`, and Effigy selectors. A disposable desktop proof
  panel is deferred to avoid UI churn. The next lane audits task/project
  workflow depth before adding more behavior.

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
- `045-turn-start-executor-smoke-boundary-split.md` - completed
- `046-turn-start-stdio-execution-envelope-split.md` - completed
- `047-stdio-frame-ingestion-persistence-split.md` - completed
- `048-durable-executor-dispatch-admission-split.md` - completed
- `049-doctor-green-health-closeout-and-next-lane-selection.md` - completed
- `050-git-branch-worktree-runner-proof.md` - completed
- `051-git-commit-runner-proof.md` - completed
- `052-git-push-runner-proof.md` - completed
- `053-forge-pull-request-runner-proof.md` - completed
- `054-git-forge-runner-health-boundary-rebaseline.md` - completed
- `055-provider-auth-forge-execution-contract-lane.md` - completed
- `056-stopped-provider-auth-forge-admission-records.md` - completed
- `057-stopped-forge-network-preflight-control.md` - completed
- `058-stopped-forge-network-request-receipt.md` - completed
- `059-stopped-forge-network-outcome-persistence-control.md` - completed
- `060-forge-network-stopped-runner-health-boundary-rebaseline.md` - completed
- `061-stopped-provider-credential-status-refresh-control.md` - completed
- `062-stopped-provider-credential-status-refresh-persistence.md` - completed
- `063-provider-auth-stopped-boundary-health-rebaseline.md` - completed
- `064-stopped-provider-repository-metadata-refresh-control.md` - completed
- `065-stopped-provider-repository-metadata-refresh-persistence.md` - completed
- `066-stopped-provider-pull-request-refresh-control.md` - completed
- `067-stopped-provider-pull-request-refresh-persistence.md` - completed
- `068-provider-forge-read-pattern-consolidation.md` - completed
- `069-provider-read-intent-projection-control.md` - completed
- `070-provider-read-intent-query-composition.md` - completed
- `071-provider-read-intent-control-boundary.md` - completed
- `072-provider-read-intent-boundary-rebaseline.md` - completed
- `073-provider-read-intent-serialized-control-envelope.md` - completed
- `074-provider-read-intent-nucleusd-query.md` - completed
- `075-provider-read-intent-tauri-ipc-consumption.md` - completed
- `076-provider-read-intent-product-consumption-decision.md` - completed
- `077-provider-readiness-overview-projection.md` - completed
- `078-provider-readiness-overview-query-control.md` - completed
- `079-provider-readiness-overview-nucleusd-query.md` - completed
- `080-provider-readiness-overview-tauri-ipc-consumption.md` - completed
- `081-provider-readiness-overview-product-consumption-decision.md` - completed
- `082-provider-readiness-overview-desktop-proof-surface.md` - completed
- `083-provider-readiness-overview-seeded-evidence-proof.md` - completed
- `084-provider-readiness-overview-drilldown-read-model.md` - completed
- `085-provider-readiness-product-closeout-and-next-lane-selection.md` - completed
- `086-stopped-provider-status-check-refresh.md` - completed
- `087-provider-readiness-coverage-and-next-provider-gate.md` - completed
- `088-provider-live-read-admission-gate.md` - completed
- `089-provider-live-read-execution-contract-and-adapter-boundary.md` - completed
- `090-provider-live-read-smoke-approval-gate.md` - completed
- `091-provider-live-read-smoke-operator-approval-checkpoint.md` - completed
- `092-provider-live-read-smoke-closeout-and-executor-selection.md` - completed
- `093-provider-live-read-server-owned-executor.md` - completed
- `094-provider-live-read-executor-control-surface.md` - completed
- `095-provider-live-read-executor-command-runner-handoff.md` - completed
- `096-provider-live-read-command-runner-smoke-approval.md` - completed
- `097-provider-live-read-approved-smoke-evidence-promotion.md` - completed
- `098-provider-live-read-approved-smoke-evidence-control-surface.md` - completed
- `099-provider-live-read-approved-smoke-evidence-persistence.md` - completed
- `100-provider-live-read-smoke-evidence-state-backed-query.md` - completed
- `101-provider-live-read-smoke-evidence-seed-replay.md` - completed
- `102-provider-live-read-smoke-evidence-readiness-integration.md` - completed
- `103-provider-live-read-second-family-selection.md` - completed
- `104-provider-live-read-second-family-stopped-request.md` - completed
- `105-provider-live-read-boundary-stocktake.md` - completed
- `106-provider-live-read-status-check-smoke.md` - completed
- `107-provider-live-read-reassessment.md` - completed
- `108-server-client-workflow-hardening.md` - active
- `109-task-timeline-authority-map-control-parity.md` - completed
- `110-task-project-workflow-depth.md` - completed
- `111-planning-artifact-task-seed-promotion.md` - completed
- `112-planning-task-seed-persistence-and-projection.md` - completed
- `113-task-seed-promotion-command.md` - completed
- `114-planning-management-projection-payloads.md` - completed
- `115-planning-projection-file-export-capture.md` - completed
- `116-planning-projection-capture-publication-gate.md` - completed
- `117-planning-projection-import-admission.md` - active

## Batch Cards

Ready cards:

- `batch-cards/497-planning-projection-import-boundary-selection.md`

Paused cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/488-planning-projection-file-export-validation.md`
- `batch-cards/487-planning-projection-cli-effigy-inspection.md`
- `batch-cards/486-planning-projection-capture-prep-records.md`
- `batch-cards/485-planning-projection-file-write-diagnostics.md`
- `batch-cards/484-planning-projection-file-document-materialization.md`
- `batch-cards/483-planning-projection-file-write-boundary-selection.md`
- `batch-cards/482-planning-management-projection-next-lane-checkpoint.md`
- `batch-cards/481-planning-management-projection-validation.md`
- `batch-cards/480-planning-management-projection-query-diagnostics.md`
- `batch-cards/479-planning-management-projection-export-plan.md`
- `batch-cards/478-planning-management-projection-codec-tests.md`
- `batch-cards/477-planning-management-projection-file-refs.md`
- `batch-cards/476-planning-management-projection-record-kinds.md`
- `batch-cards/475-planning-management-projection-payload-selection.md`
- `batch-cards/474-task-seed-promotion-closeout.md`
- `batch-cards/473-task-seed-promotion-next-lane-checkpoint.md`
- `batch-cards/472-task-seed-promotion-validation.md`
- `batch-cards/471-task-seed-promotion-cli-effigy.md`
- `batch-cards/470-task-seed-promotion-diagnostics-query.md`
- `batch-cards/469-task-seed-promotion-state-persistence.md`
- `batch-cards/468-task-seed-promotion-command-model.md`
- `batch-cards/467-task-seed-promotion-admission-selection.md`
- `batch-cards/466-planning-task-seed-persistence-closeout.md`
- `batch-cards/465-planning-task-seed-promotion-readiness-reassessment.md`
- `batch-cards/464-planning-task-seed-persistence-validation.md`
- `batch-cards/463-planning-artifact-management-projection-shape.md`
- `batch-cards/462-planning-task-seed-fixture-effigy-smoke.md`
- `batch-cards/461-planning-task-seed-query-from-persistence.md`
- `batch-cards/460-planning-task-seed-local-store-records.md`
- `batch-cards/459-planning-task-seed-storage-codec-selection.md`
- `batch-cards/458-planning-task-seed-closeout.md`
- `batch-cards/457-planning-task-seed-next-lane-checkpoint.md`
- `batch-cards/456-planning-task-seed-validation.md`
- `batch-cards/455-planning-task-seed-query-control-cli-effigy.md`
- `batch-cards/454-planning-task-seed-record-implementation.md`
- `batch-cards/448-task-project-workflow-validation.md`
- `batch-cards/447-task-project-control-cli-effigy.md`
- `batch-cards/446-task-project-read-model-implementation.md`
- `batch-cards/445-next-task-readiness-surface-selection.md`
- `batch-cards/444-task-project-workflow-gap-matrix.md`
- `batch-cards/443-task-project-workflow-implementation-audit.md`
- `batch-cards/442-task-timeline-authority-map-desktop-proof-decision.md`
- `batch-cards/441-task-timeline-authority-map-validation.md`
- `batch-cards/440-task-timeline-authority-map-cli-effigy.md`
- `batch-cards/439-project-authority-map-control-envelope-dto.md`
- `batch-cards/438-task-timeline-control-envelope-dto.md`
- `batch-cards/437-task-timeline-control-envelope-audit.md`
- `batch-cards/367-provider-live-read-smoke-closeout-validation.md`
- `batch-cards/366-provider-live-read-executor-gap-selection.md`
- `batch-cards/365-provider-live-read-smoke-evidence-promotion.md`
- `batch-cards/364-provider-live-read-smoke-approval-validation.md`
- `batch-cards/363-provider-live-read-stopped-smoke-request.md`
- `batch-cards/362-provider-live-read-smoke-authority-checklist.md`
- `batch-cards/361-provider-live-read-smoke-target-selection.md`
- `batch-cards/360-provider-live-read-execution-lane-validation.md`
- `batch-cards/359-provider-live-read-execution-boundary-rebaseline.md`
- `batch-cards/358-provider-live-read-fixture-response-diagnostics.md`
- `batch-cards/357-provider-live-read-stopped-executor-handoff.md`
- `batch-cards/356-provider-live-read-fixture-client-boundary.md`
- `batch-cards/355-provider-live-read-execution-contract-delta.md`
- `batch-cards/354-provider-live-read-gate-validation-closeout.md`
- `batch-cards/353-provider-live-read-boundary-rebaseline.md`
- `batch-cards/352-provider-live-read-control-diagnostics.md`
- `batch-cards/351-provider-live-read-persistence-diagnostics.md`
- `batch-cards/350-provider-live-read-request-receipt-planning.md`
- `batch-cards/349-provider-live-read-preflight-tests.md`
- `batch-cards/348-provider-live-read-preflight-blockers.md`
- `batch-cards/347-provider-live-read-preflight-type-surface.md`
- `batch-cards/346-provider-live-read-admission-tests.md`
- `batch-cards/345-provider-live-read-admission-control-dto.md`
- `batch-cards/344-provider-live-read-admission-blockers.md`
- `batch-cards/343-provider-live-read-admission-type-surface.md`
- `batch-cards/342-provider-readiness-gate-validation-closeout.md`
- `batch-cards/341-provider-next-roadmap-runway.md`
- `batch-cards/340-provider-live-read-gate-scope.md`
- `batch-cards/339-provider-next-lane-options.md`
- `batch-cards/338-provider-readiness-gap-index-refresh.md`
- `batch-cards/337-provider-readiness-coverage-audit.md`
- `batch-cards/336-provider-status-check-refresh-lane-closeout.md`
- `batch-cards/335-provider-readiness-status-check-seed-proof.md`
- `batch-cards/334-provider-read-intent-status-check-query-dto.md`
- `batch-cards/333-provider-read-intent-status-check-projection.md`
- `batch-cards/332-provider-status-check-refresh-persistence-validation-closeout.md`
- `batch-cards/331-provider-status-check-refresh-persistence-blocker-tests.md`
- `batch-cards/330-provider-status-check-refresh-persistence-diagnostics-control.md`
- `batch-cards/329-provider-status-check-refresh-persistence-store.md`
- `batch-cards/328-provider-status-check-refresh-persistence-type-surface.md`
- `batch-cards/327-provider-status-check-refresh-validation-closeout.md`
- `batch-cards/326-provider-status-check-refresh-blocker-tests.md`
- `batch-cards/325-provider-status-check-refresh-control-dto.md`
- `batch-cards/324-provider-status-check-refresh-record-builder.md`
- `batch-cards/323-provider-status-check-refresh-type-surface.md`
- `batch-cards/322-provider-readiness-closeout-validation.md`
- `batch-cards/321-next-provider-lane-selection.md`
- `batch-cards/320-provider-boundary-gap-refresh.md`
- `batch-cards/319-provider-readiness-proof-closeout-summary.md`
- `batch-cards/318-provider-readiness-drilldown-validation-closeout.md`
- `batch-cards/317-provider-readiness-drilldown-rendering-proof.md`
- `batch-cards/316-provider-readiness-drilldown-request-path.md`
- `batch-cards/315-provider-readiness-drilldown-surface-audit.md`
- `batch-cards/314-provider-readiness-overview-seeded-validation-closeout.md`
- `batch-cards/313-provider-readiness-overview-desktop-nonempty-proof.md`
- `batch-cards/312-provider-readiness-overview-desktop-seed-path.md`
- `batch-cards/311-provider-readiness-overview-desktop-seed-audit.md`
- `batch-cards/310-provider-readiness-overview-desktop-validation-closeout.md`
- `batch-cards/307-provider-readiness-overview-desktop-surface-audit.md`
- `batch-cards/308-provider-readiness-overview-desktop-request-path.md`
- `batch-cards/309-provider-readiness-overview-desktop-rendering.md`
- `batch-cards/304-provider-readiness-overview-product-consumption-options.md`
- `batch-cards/305-provider-readiness-overview-surface-contract-delta.md`
- `batch-cards/306-provider-readiness-overview-next-lane-closeout.md`
- `batch-cards/301-provider-readiness-overview-tauri-ipc-surface-selection.md`
- `batch-cards/302-provider-readiness-overview-tauri-ipc-envelope-proof.md`
- `batch-cards/303-provider-readiness-overview-tauri-ipc-validation-closeout.md`
- `batch-cards/297-provider-readiness-overview-nucleusd-query-vocabulary.md`
- `batch-cards/298-provider-readiness-overview-nucleusd-renderer.md`
- `batch-cards/299-provider-readiness-overview-effigy-selector.md`
- `batch-cards/300-provider-readiness-overview-nucleusd-validation-closeout.md`
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
- `batch-cards/148-turn-start-executor-smoke-boundary-type-split.md`
- `batch-cards/149-turn-start-executor-smoke-boundary-helper-test-split.md`
- `batch-cards/150-turn-start-executor-smoke-boundary-validation-closeout.md`
- `batch-cards/151-turn-start-stdio-execution-envelope-type-split.md`
- `batch-cards/152-turn-start-stdio-execution-envelope-helper-test-split.md`
- `batch-cards/153-turn-start-stdio-execution-envelope-validation-closeout.md`
- `batch-cards/154-stdio-frame-ingestion-persistence-type-split.md`
- `batch-cards/155-stdio-frame-ingestion-persistence-helper-test-split.md`
- `batch-cards/156-stdio-frame-ingestion-persistence-validation-closeout.md`
- `batch-cards/157-durable-executor-dispatch-admission-type-split.md`
- `batch-cards/158-durable-executor-dispatch-admission-helper-test-split.md`
- `batch-cards/159-durable-executor-dispatch-admission-validation-closeout.md`
- `batch-cards/160-doctor-green-health-evidence-closeout.md`
- `batch-cards/161-god-file-warning-pressure-triage.md`
- `batch-cards/162-next-implementation-lane-selection.md`
- `batch-cards/163-git-branch-worktree-runner-authority-refresh.md`
- `batch-cards/164-git-branch-worktree-runner-command-adapter.md`
- `batch-cards/165-git-branch-worktree-runner-outcome-persistence.md`
- `batch-cards/166-git-branch-worktree-runner-diagnostics-control.md`
- `batch-cards/167-git-branch-worktree-runner-validation-closeout.md`
- `batch-cards/168-git-commit-runner-authority-records.md`
- `batch-cards/169-git-commit-runner-command-adapter.md`
- `batch-cards/170-git-commit-runner-outcome-persistence.md`
- `batch-cards/171-git-commit-runner-diagnostics-control.md`
- `batch-cards/172-git-commit-runner-validation-closeout.md`
- `batch-cards/173-git-push-runner-authority-records.md`
- `batch-cards/174-git-push-runner-command-adapter.md`
- `batch-cards/175-git-push-runner-outcome-persistence.md`
- `batch-cards/176-git-push-runner-diagnostics-control.md`
- `batch-cards/177-git-push-runner-validation-closeout.md`
- `batch-cards/178-forge-pull-request-runner-authority-records.md`
- `batch-cards/179-forge-pull-request-runner-request-adapter.md`
- `batch-cards/180-forge-pull-request-runner-outcome-persistence.md`
- `batch-cards/181-forge-pull-request-runner-diagnostics-control.md`
- `batch-cards/182-forge-pull-request-runner-validation-closeout.md`
- `batch-cards/183-git-forge-runner-health-evidence-refresh.md`
- `batch-cards/184-runner-boundary-authority-audit.md`
- `batch-cards/185-runner-warning-pressure-triage.md`
- `batch-cards/186-next-provider-auth-lane-selection.md`
- `batch-cards/187-git-forge-runner-rebaseline-validation-closeout.md`
- `batch-cards/188-provider-auth-contract-surface.md`
- `batch-cards/189-forge-network-admission-boundary.md`
- `batch-cards/190-provider-evidence-idempotency-recovery-rules.md`
- `batch-cards/191-provider-auth-contract-index-closeout.md`
- `batch-cards/192-next-stopped-provider-admission-selection.md`
- `batch-cards/193-provider-auth-contract-validation-closeout.md`
- `batch-cards/194-provider-auth-admission-type-surface.md`
- `batch-cards/195-forge-network-admission-record-builder.md`
- `batch-cards/196-forge-network-admission-blocker-tests.md`
- `batch-cards/197-forge-network-admission-export-wiring.md`
- `batch-cards/198-forge-network-admission-validation-closeout.md`
- `batch-cards/199-forge-network-preflight-type-surface.md`
- `batch-cards/200-forge-network-preflight-record-builder.md`
- `batch-cards/201-forge-network-preflight-control-dto.md`
- `batch-cards/202-forge-network-preflight-blocker-tests.md`
- `batch-cards/203-forge-network-preflight-validation-closeout.md`
- `batch-cards/204-forge-network-request-receipt-type-surface.md`
- `batch-cards/205-forge-network-request-receipt-builder.md`
- `batch-cards/206-forge-network-request-receipt-control-dto.md`
- `batch-cards/207-forge-network-request-receipt-blocker-tests.md`
- `batch-cards/208-forge-network-request-receipt-validation-closeout.md`
- `batch-cards/209-forge-network-outcome-persistence-type-surface.md`
- `batch-cards/210-forge-network-outcome-persistence-store.md`
- `batch-cards/211-forge-network-outcome-diagnostics-control.md`
- `batch-cards/212-forge-network-outcome-blocker-tests.md`
- `batch-cards/213-forge-network-outcome-validation-closeout.md`
- `batch-cards/214-forge-network-health-evidence-refresh.md`
- `batch-cards/215-forge-network-boundary-authority-audit.md`
- `batch-cards/216-forge-network-warning-pressure-triage.md`
- `batch-cards/217-next-provider-credential-status-lane-selection.md`
- `batch-cards/218-forge-network-rebaseline-validation-closeout.md`
- `batch-cards/219-provider-credential-status-refresh-type-surface.md`
- `batch-cards/220-provider-credential-status-refresh-record-builder.md`
- `batch-cards/221-provider-credential-status-refresh-control-dto.md`
- `batch-cards/222-provider-credential-status-refresh-blocker-tests.md`
- `batch-cards/223-provider-credential-status-refresh-validation-closeout.md`
- `batch-cards/224-provider-credential-status-refresh-persistence-type-surface.md`
- `batch-cards/225-provider-credential-status-refresh-persistence-store.md`
- `batch-cards/226-provider-credential-status-refresh-persistence-diagnostics-control.md`
- `batch-cards/227-provider-credential-status-refresh-persistence-blocker-tests.md`
- `batch-cards/228-provider-credential-status-refresh-persistence-validation-closeout.md`
- `batch-cards/229-provider-auth-credential-status-evidence-refresh.md`
- `batch-cards/230-provider-auth-forge-network-evidence-refresh.md`
- `batch-cards/231-provider-auth-boundary-authority-audit.md`
- `batch-cards/232-provider-auth-warning-pressure-triage.md`
- `batch-cards/233-next-provider-repository-metadata-lane-selection.md`
- `batch-cards/234-provider-repository-metadata-refresh-type-surface.md`
- `batch-cards/235-provider-repository-metadata-refresh-record-builder.md`
- `batch-cards/236-provider-repository-metadata-refresh-control-dto.md`
- `batch-cards/237-provider-repository-metadata-refresh-blocker-tests.md`
- `batch-cards/238-provider-repository-metadata-refresh-validation-closeout.md`
- `batch-cards/239-provider-repository-metadata-refresh-persistence-type-surface.md`
- `batch-cards/240-provider-repository-metadata-refresh-persistence-store.md`
- `batch-cards/241-provider-repository-metadata-refresh-persistence-diagnostics-control.md`
- `batch-cards/242-provider-repository-metadata-refresh-persistence-blocker-tests.md`
- `batch-cards/243-provider-repository-metadata-refresh-persistence-validation-closeout.md`
- `batch-cards/244-provider-pull-request-refresh-type-surface.md`
- `batch-cards/245-provider-pull-request-refresh-record-builder.md`
- `batch-cards/246-provider-pull-request-refresh-control-dto.md`
- `batch-cards/247-provider-pull-request-refresh-blocker-tests.md`
- `batch-cards/248-provider-pull-request-refresh-validation-closeout.md`
- `batch-cards/249-provider-pull-request-refresh-persistence-type-surface.md`
- `batch-cards/250-provider-pull-request-refresh-persistence-store.md`
- `batch-cards/251-provider-pull-request-refresh-persistence-diagnostics-control.md`
- `batch-cards/252-provider-pull-request-refresh-persistence-blocker-tests.md`
- `batch-cards/253-provider-pull-request-refresh-persistence-validation-closeout.md`
- `batch-cards/254-provider-forge-read-pattern-summary.md`
- `batch-cards/255-provider-forge-read-family-fanout-pause.md`
- `batch-cards/256-provider-forge-next-integration-lane-selection.md`
- `batch-cards/257-provider-read-intent-projection-type-surface.md`
- `batch-cards/258-provider-read-intent-projection-entry-builders.md`
- `batch-cards/259-provider-read-intent-projection-control-dto.md`
- `batch-cards/260-provider-read-intent-projection-tests.md`
- `batch-cards/261-provider-read-intent-projection-validation-closeout.md`
- `batch-cards/262-provider-read-intent-query-type-surface.md`
- `batch-cards/263-provider-read-intent-query-store-composition.md`
- `batch-cards/264-provider-read-intent-query-tests.md`
- `batch-cards/265-provider-read-intent-query-validation-closeout.md`
- `batch-cards/266-provider-read-intent-control-query-vocabulary.md`
- `batch-cards/267-provider-read-intent-control-handler-route.md`
- `batch-cards/268-provider-read-intent-control-boundary-tests.md`
- `batch-cards/269-provider-read-intent-control-boundary-validation-closeout.md`
- `batch-cards/270-provider-read-intent-contract-delta.md`
- `batch-cards/271-provider-read-intent-envelope-boundary-audit.md`
- `batch-cards/272-provider-read-intent-next-lane-selection.md`
- `batch-cards/273-provider-read-intent-rebaseline-validation-closeout.md`
- `batch-cards/274-provider-read-intent-query-dto-vocabulary.md`
- `batch-cards/275-provider-read-intent-response-dto-module.md`
- `batch-cards/276-provider-read-intent-envelope-tests.md`
- `batch-cards/277-provider-read-intent-serialized-envelope-validation-closeout.md`
- `batch-cards/278-provider-read-intent-nucleusd-query-vocabulary.md`
- `batch-cards/279-provider-read-intent-nucleusd-renderer.md`
- `batch-cards/280-provider-read-intent-effigy-selector.md`
- `batch-cards/281-provider-read-intent-nucleusd-validation-closeout.md`
- `batch-cards/282-provider-read-intent-tauri-ipc-surface-selection.md`
- `batch-cards/283-provider-read-intent-tauri-ipc-envelope-proof.md`
- `batch-cards/284-provider-read-intent-tauri-ipc-validation-closeout.md`
- `batch-cards/285-provider-read-intent-consumption-options.md`
- `batch-cards/286-provider-readiness-overview-contract-delta.md`
- `batch-cards/287-provider-readiness-overview-runway-selection.md`
- `batch-cards/288-provider-consumption-decision-validation-closeout.md`
- `batch-cards/289-provider-readiness-overview-type-surface.md`
- `batch-cards/290-provider-readiness-overview-composer.md`
- `batch-cards/291-provider-readiness-overview-tests.md`
- `batch-cards/292-provider-readiness-overview-validation-closeout.md`
- `batch-cards/293-provider-readiness-overview-query-vocabulary.md`
- `batch-cards/294-provider-readiness-overview-handler-route.md`
- `batch-cards/295-provider-readiness-overview-response-dto.md`
- `batch-cards/296-provider-readiness-overview-query-control-validation-closeout.md`

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
38. Turn-start executor smoke boundary split - completed
39. Turn-start stdio execution envelope split - completed
40. Stdio frame ingestion persistence split - completed
41. Durable executor dispatch admission split - completed
42. Doctor-green health closeout and next lane selection - completed
43. Git branch/worktree runner proof - completed
44. Git commit runner proof - completed
45. Git push runner proof - completed
46. Stopped forge pull-request runner proof - completed
47. Provider-auth and forge execution contract lane - completed
48. Stopped provider-auth and forge admission records - completed
49. Stopped forge network preflight/control records - completed
50. Stopped forge network request/receipt records - completed
51. Stopped forge network outcome persistence/control records - completed
52. Forge network stopped-runner health and boundary rebaseline - completed
53. Stopped provider credential-status refresh/control records - completed
54. Stopped provider credential-status refresh persistence/control records -
    completed
55. Provider-auth stopped-boundary health rebaseline - completed
56. Stopped provider repository metadata refresh/control records - completed
57. Stopped provider repository metadata refresh persistence/control records -
    completed
58. Stopped provider pull-request/merge-request refresh/control records -
    completed
59. Stopped provider pull-request/merge-request refresh persistence/control
    records - completed
60. Provider-forge read-pattern consolidation - completed
61. Generic provider read-intent projection/control - completed
62. Provider read-intent query composition - completed
63. Provider read-intent control boundary - completed
64. Provider read-intent boundary rebaseline - completed
65. Provider read-intent serialized control envelope - completed
66. Provider read-intent `nucleusd` query - completed
67. Provider read-intent Tauri IPC consumption - completed
68. Provider read-intent product consumption decision - completed
69. Provider Readiness Overview projection - completed
70. Provider Readiness Overview query/control integration - completed
71. Provider Readiness Overview `nucleusd` query - completed
72. Provider Readiness Overview Tauri IPC consumption - completed
73. Provider Readiness Overview product consumption decision - completed
74. Provider Readiness Overview desktop proof surface - completed
75. Provider Readiness Overview seeded evidence proof - completed
76. Provider Readiness Overview drilldown read model - completed
77. Provider Readiness product closeout and next-lane selection - completed
78. Stopped provider status/check refresh - completed
79. Provider readiness coverage and next provider gate - completed
80. Provider live-read admission gate - completed
81. Provider live-read execution contract and adapter boundary - completed
82. Provider live-read smoke approval gate - completed
83. Provider live-read smoke operator approval checkpoint - completed
84. Provider live-read smoke closeout and executor selection - completed
85. Provider live-read server-owned executor - completed
86. Provider live-read executor control surface - completed
87. Provider live-read executor command-runner handoff - completed
88. Provider live-read command-runner smoke approval - completed
89. Provider live-read approved smoke evidence promotion - completed
90. Provider live-read approved smoke evidence control surface - completed
91. Provider live-read approved smoke evidence persistence - completed
92. Provider live-read smoke evidence state-backed query - completed
93. Provider live-read smoke evidence seed replay - completed
94. Provider live-read smoke evidence readiness integration - completed
95. Provider live-read second family selection - completed
96. Provider live-read second family stopped request - completed
97. Provider live-read boundary stocktake - completed
98. Provider live-read status/check smoke - completed
99. Provider live-read reassessment - completed
100. Server/client workflow hardening - active
101. Task timeline authority-map control parity - completed
102. Task/project workflow depth - completed
103. Planning artifact task seed promotion - completed
104. Planning task seed persistence and projection - completed
105. Task seed promotion command - completed
106. Planning management projection payloads - completed
107. Planning projection file export capture - completed
108. Planning projection capture publication gate - active

Current stop:

- approved live provider read smoke completed for `gh repo view
  octocat/Hello-World --json
  nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt`
- promoted selected-field smoke evidence records now link command smoke
  request, handoff, sanitized output, and receipt ids
- read-only query/control, `nucleusd`, and Effigy inspection now expose
  promoted evidence diagnostics without running provider commands
- promoted approved smoke evidence can now be persisted and read back as a
  sanitized local-store record
- smoke evidence diagnostics now read from persisted approved evidence records;
  empty state reports zero evidence until an explicit seed/replay path writes
  sanitized local evidence
- approved smoke evidence can now be replayed explicitly into local state via
  a duplicate-safe CLI/Effigy surface without provider execution
- provider readiness overview now carries a read-only approved live-read smoke
  evidence source count without treating one smoke as general readiness
- status/check refresh is selected as the second provider live-read family,
  using a stopped `gh pr checks` selected-field shape before approval
- status/check live-read target, authority checklist, stopped request, and
  diagnostics records now exist without provider execution
- operator approval has opened one bounded status/check live smoke using
  selected fields and sanitized evidence only
- approved status/check smoke completed against `cli/cli#13705` with exit code
  `0`; sanitized counts are 18 checks, 11 pass, 7 skipped, and no failures,
  pending checks, or cancellations
- status/check smoke evidence records now preserve selected fields, target,
  counts, exit code, and guardrail flags without raw provider payloads
- provider execution work is paused after live-read proof; server/client
  workflow hardening over existing read models and control envelopes became the
  follow-on lane
- server/client inventory and gap matrix selected task timeline and project
  authority-map read-only control parity as the first implementation batch
- task timeline and project authority-map query DTOs, `nucleusd` domains,
  Effigy selectors, typed output lines, and focused tests are complete
- planning artifact/task seed projection payloads, deterministic file refs,
  TOML codecs, export planning, file materialization, write diagnostics, and
  capture-prep evidence are complete
- roadmap `115` closed without import/apply, SCM/forge mutation, provider
  execution, task promotion, or UI behavior
- roadmap `116` closed with an adapter-neutral publication/share gate for
  prepared planning projection management captures
- roadmap `117` is active and selects planning projection import/admission as
  the next lane
- ready card:
  `batch-cards/504-planning-projection-import-next-lane-checkpoint.md`
- publication/share admission records now distinguish Git-like,
  snapshot/publication-like, forge-review-like, manual, and custom adapter
  families without granting the underlying effect
- stopped publication/share requests now persist sanitized request intent from
  admitted planning capture publication records
- diagnostics now report stopped request counts, blockers, adapter-family
  buckets, operation buckets, evidence refs, file refs, and no-effect flags
- read-only server, DTO, `nucleusd`, and Effigy inspection now expose planning
  capture publication readiness without executing effects
- validation for the planning capture publication gate is complete
- the import/admission boundary is selected: scan candidates, stopped
  admission, conflict staging, and deferred apply are distinct stages
- read-only projected-file scan candidates now classify ready planning
  artifact/task-seed refs and blocked unsupported schema, unsafe path,
  unsupported kind, and parse-failure states without effects
- stopped import admission records now admit reviewed candidates, block
  unreviewed/blocked/conflicting/missing-id candidates, and duplicate-noop
  repeated file refs without effects
- semantic conflict staging now links artifact, task seed, and missing-ref
  conflicts to candidate/admission records without resolving conflicts or
  applying imports
- read-only diagnostics now summarize candidates, admissions, blockers,
  duplicates, conflicts, evidence refs, and no-effect flags
- next work is adding optional read-only server query, `nucleusd`, and Effigy
  inspection for import diagnostics
- provider writes, task mutation, callbacks, interruption/recovery execution,
  raw payload retention, active planning mutation, semantic merge resolution,
  task promotion, and credential material storage remain blocked
