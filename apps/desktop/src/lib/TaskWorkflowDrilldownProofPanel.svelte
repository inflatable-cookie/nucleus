<script lang="ts">
  import { Button, StatusIndicator, Surface, Text } from "@poodle/svelte";
  import { refreshCw } from "@poodle/icons-lucide";
  import {
    buildArchiveTaskCommand,
    buildBlockTaskCommand,
    buildCompleteTaskCommand,
    buildStartTaskCommand,
    queryProductWorkflowSummary,
    querySelectedTaskActionReadiness,
    querySelectedTaskCommandAdmission,
    querySelectedTaskOperatorActionGate,
    querySelectedTaskReviewDecisionAdmission,
    querySelectedTaskReviewDecisionApply,
    querySelectedTaskReviewNext,
    querySelectedTaskReviewOutcomeRoute,
    querySelectedTaskRouteAdmission,
    querySelectedTaskScmHandoff,
    queryTaskWorkflowDrilldown,
    submitControlEnvelope,
    type ControlSelectedTaskActionDto,
    type ControlSelectedTaskCommandAdmissionDto,
    type ControlSelectedTaskReviewDecisionAdmissionDto,
    type ControlSelectedTaskReviewDecisionRecordDto,
    type ControlSelectedTaskOperatorActionCandidateDto,
    type ControlTaskRecordDto,
    type ControlTaskWorkflowDrilldownDto,
    type ControlTaskWorkflowGapDto,
    type ProductWorkflowSummaryQueryResult,
    type SelectedTaskActionReadinessQueryResult,
    type SelectedTaskOperatorActionGateQueryResult,
    type SelectedTaskReviewDecisionAction,
    type SelectedTaskReviewNextQueryResult,
    type SelectedTaskReviewOutcomeRouteQueryResult,
    type SelectedTaskRouteAdmissionQueryResult,
    type SelectedTaskScmHandoffQueryResult,
    type TaskWorkflowDrilldownQueryResult,
  } from "./control";

  type Props = {
    selectedTask: ControlTaskRecordDto | null;
    onTaskCommandChanged?: () => void;
  };

  type CommandReceiptSummary = {
    commandId: string;
    status: string;
    family: string;
    action: string;
    submittedRevision: string;
  };

  type ReviewDecisionAdmissionMap = Partial<
    Record<SelectedTaskReviewDecisionAction, ControlSelectedTaskReviewDecisionAdmissionDto>
  >;

  let { selectedTask, onTaskCommandChanged }: Props = $props();

  const fallbackProjectId = "project:nucleus-local";
  const fallbackTaskId = "task:nucleus-local:bootstrap";
  const reviewDecisionActions: SelectedTaskReviewDecisionAction[] = [
    "accept_evidence",
    "request_changes",
    "reject_evidence",
    "abandon_review",
  ];

  let loading = $state(false);
  let result = $state<TaskWorkflowDrilldownQueryResult | null>(null);
  let workflowResult = $state<ProductWorkflowSummaryQueryResult | null>(null);
  let actionReadinessResult = $state<SelectedTaskActionReadinessQueryResult | null>(null);
  let operatorGateResult = $state<SelectedTaskOperatorActionGateQueryResult | null>(null);
  let reviewNextResult = $state<SelectedTaskReviewNextQueryResult | null>(null);
  let reviewOutcomeRouteResult = $state<SelectedTaskReviewOutcomeRouteQueryResult | null>(null);
  let routeAdmissionResult = $state<SelectedTaskRouteAdmissionQueryResult | null>(null);
  let scmHandoffResult = $state<SelectedTaskScmHandoffQueryResult | null>(null);
  let failure = $state<string | null>(null);
  let commandPending = $state<string | null>(null);
  let blockReason = $state("");
  let commandReceipt = $state<CommandReceiptSummary | null>(null);
  let lastAdmission = $state<ControlSelectedTaskCommandAdmissionDto | null>(null);
  let awaitingTaskRefresh = $state(false);
  let lastCommandRevision = $state<string | null>(null);
  let reviewDecisionAdmissions = $state<ReviewDecisionAdmissionMap>({});
  let reviewDecisionApplyResult = $state<ControlSelectedTaskReviewDecisionRecordDto | null>(null);
  let reviewDecisionPending = $state<SelectedTaskReviewDecisionAction | null>(null);
  let reviewDecisionReason = $state("");
  let reviewDecisionFailure = $state<string | null>(null);

  const projectId = $derived(selectedTask?.project_id ?? fallbackProjectId);
  const taskId = $derived(selectedTask?.task_id ?? fallbackTaskId);
  const drilldown = $derived(result?.state === "record" ? result.drilldown : null);
  const workflowSummary = $derived(
    workflowResult?.state === "record" ? workflowResult.summary : null,
  );
  const actionReadiness = $derived(
    actionReadinessResult?.state === "record" ? actionReadinessResult.readiness : null,
  );
  const operatorGate = $derived(
    operatorGateResult?.state === "record" ? operatorGateResult.gate : null,
  );
  const reviewNext = $derived(
    reviewNextResult?.state === "record" ? reviewNextResult.reviewNext : null,
  );
  const reviewOutcomeRoute = $derived(
    reviewOutcomeRouteResult?.state === "record" ? reviewOutcomeRouteResult.route : null,
  );
  const routeAdmission = $derived(
    routeAdmissionResult?.state === "record" ? routeAdmissionResult.admission : null,
  );
  const scmHandoff = $derived(
    scmHandoffResult?.state === "record" ? scmHandoffResult.handoff : null,
  );
  const allowedActions = $derived(
    actionReadiness?.actions.filter((action) => action.status === "allowed") ?? [],
  );
  const blockedActions = $derived(
    actionReadiness?.actions.filter((action) => action.status === "blocked") ?? [],
  );
  const otherActions = $derived(
    actionReadiness?.actions.filter(
      (action) => action.status !== "allowed" && action.status !== "blocked",
    ) ?? [],
  );
  const taskCommandCandidates = $derived(
    operatorGate?.candidates.filter(
      (candidate) => candidate.disposition === "task_command_candidate",
    ) ?? [],
  );
  const blockedGateCandidates = $derived(
    operatorGate?.candidates.filter((candidate) => candidate.disposition === "blocked") ?? [],
  );
  const passiveGateCandidates = $derived(
    operatorGate?.candidates.filter(
      (candidate) => candidate.disposition === "read_only" || candidate.disposition === "deferred",
    ) ?? [],
  );
  const selectedLane = $derived(
    workflowSummary?.task_lanes.find((lane) => lane.task_refs.includes(taskId)) ?? null,
  );
  const noEffects = $derived(drilldown ? noEffectFlags(drilldown).every((row) => !row[1]) : false);
  const statusLabel = $derived(
    loading
      ? "loading"
      : failure
        ? "error"
        : drilldown
          ? drilldown.guidance.safe_action
          : (result?.state ?? "idle"),
  );
  const statusTone = $derived(
    loading ? "pending" : failure ? "danger" : noEffects ? "success" : "info",
  );
  const waitingForServerTaskRecord = $derived(
    Boolean(
      awaitingTaskRefresh &&
        selectedTask &&
        lastCommandRevision &&
        selectedTask.revision_id === lastCommandRevision,
    ),
  );
  const receiptTimelineRefs = $derived(drilldown?.timeline.entry_refs ?? []);
  const receiptTimelinePreview = $derived(receiptTimelineRefs.slice(0, 3));
  const reviewDecisionEvidenceRefs = $derived(reviewNext?.review.evidence_refs ?? []);

  async function loadDrilldown() {
    loading = true;
    failure = null;

    try {
      const [
        workflow,
        drilldownResult,
        actionReadiness,
        operatorGate,
        reviewNext,
        reviewOutcomeRoute,
        routeAdmission,
        scmHandoff,
      ] = await Promise.all([
        queryProductWorkflowSummary(projectId),
        queryTaskWorkflowDrilldown(projectId, taskId),
        querySelectedTaskActionReadiness(projectId, taskId),
        querySelectedTaskOperatorActionGate(projectId, taskId),
        querySelectedTaskReviewNext(projectId, taskId),
        querySelectedTaskReviewOutcomeRoute(projectId, taskId),
        querySelectedTaskRouteAdmission(projectId, taskId, selectedTask?.revision_id ?? null),
        querySelectedTaskScmHandoff(projectId, taskId),
      ]);
      workflowResult = workflow;
      result = drilldownResult;
      actionReadinessResult = actionReadiness;
      operatorGateResult = operatorGate;
      reviewNextResult = reviewNext;
      reviewOutcomeRouteResult = reviewOutcomeRoute;
      routeAdmissionResult = routeAdmission;
      scmHandoffResult = scmHandoff;
      await refreshReviewDecisionAdmissions(reviewNext);
    } catch (error) {
      result = null;
      workflowResult = null;
      actionReadinessResult = null;
      operatorGateResult = null;
      reviewNextResult = null;
      reviewOutcomeRouteResult = null;
      routeAdmissionResult = null;
      scmHandoffResult = null;
      reviewDecisionAdmissions = {};
      reviewDecisionApplyResult = null;
      reviewDecisionFailure = null;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function submitSelectedTaskCommand(candidate: ControlSelectedTaskOperatorActionCandidateDto) {
    if (!selectedTask || !candidate.task_command) {
      return;
    }

    if (waitingForServerTaskRecord) {
      failure = "Waiting for refreshed server task state.";
      return;
    }

    const action = candidate.task_command.action;
    const reason = candidate.reason_required ? blockReason.trim() : null;
    if (candidate.reason_required && !reason) {
      failure = "Block requires a reason.";
      return;
    }

    commandPending = candidate.family;
    failure = null;
    lastAdmission = null;
    const submittedRevision = selectedTask.revision_id;

    try {
      const admissionResult = await querySelectedTaskCommandAdmission(
        projectId,
        taskId,
        candidate.family,
        selectedTask.revision_id,
        reason,
      );

      if (admissionResult.state !== "record") {
        failure = admissionFallbackMessage(admissionResult);
        return;
      }

      lastAdmission = admissionResult.admission;
      if (admissionResult.admission.status !== "admitted" || !admissionResult.admission.command) {
        failure =
          admissionResult.admission.refusal?.reason ??
          "Selected task command admission was refused.";
        return;
      }

      const request =
        action === "start"
          ? buildStartTaskCommand(selectedTask)
          : action === "block"
            ? buildBlockTaskCommand(selectedTask, reason ?? "")
            : action === "complete"
              ? buildCompleteTaskCommand(selectedTask)
              : action === "archive"
                ? buildArchiveTaskCommand(selectedTask)
                : null;

      if (!request) {
        failure = `Unsupported task command action: ${action}`;
        return;
      }

      const response = await submitControlEnvelope(request);
      if (response.body.type === "command_receipt") {
        commandReceipt = {
          commandId: response.body.command_id,
          status: response.body.status,
          family: candidate.family,
          action,
          submittedRevision,
        };
        if (response.body.status !== "rejected") {
          awaitingTaskRefresh = true;
          lastCommandRevision = submittedRevision;
          if (action === "block") {
            blockReason = "";
          }
          onTaskCommandChanged?.();
          await loadDrilldown();
        }
      } else if (response.body.type === "error") {
        failure = `${response.body.kind}: ${response.body.reason}`;
      } else {
        failure = `Unexpected command response: ${response.body.type}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      commandPending = null;
    }
  }

  async function refreshReviewDecisionAdmissions(
    nextResult: SelectedTaskReviewNextQueryResult | null = reviewNextResult,
  ) {
    const nextRecord = nextResult?.state === "record" ? nextResult.reviewNext : null;
    reviewDecisionFailure = null;
    reviewDecisionAdmissions = {};

    if (!nextRecord) {
      return;
    }

    const evidenceRefs = nextRecord.review.evidence_refs;
    const expectedRevision = selectedTask?.revision_id ?? null;
    const entries = await Promise.all(
      reviewDecisionActions.map(async (action) => {
        const reason = reviewDecisionReasonRequired(action)
          ? reviewDecisionReason.trim() || null
          : null;
        const result = await querySelectedTaskReviewDecisionAdmission(
          projectId,
          taskId,
          action,
          expectedRevision,
          reason,
          evidenceRefs,
          reviewDecisionIdempotencyKey("preview", action, expectedRevision),
        );
        return [action, result] as const;
      }),
    );

    const admissions: ReviewDecisionAdmissionMap = {};
    for (const [action, admissionResult] of entries) {
      if (admissionResult.state === "record") {
        admissions[action] = admissionResult.admission;
      }
    }
    reviewDecisionAdmissions = admissions;
  }

  async function submitReviewDecision(action: SelectedTaskReviewDecisionAction) {
    if (!selectedTask) {
      reviewDecisionFailure = "Select a task before applying a review decision.";
      return;
    }

    const reason = reviewDecisionReasonRequired(action) ? reviewDecisionReason.trim() : null;
    if (reviewDecisionReasonRequired(action) && !reason) {
      reviewDecisionFailure = "This review decision requires a reason.";
      return;
    }

    const admission = reviewDecisionAdmissions[action];
    if (!admission || admission.status !== "admitted" || !admission.command) {
      reviewDecisionFailure =
        admission?.refusal?.reason ?? "Preview an admitted review decision before apply.";
      return;
    }

    reviewDecisionPending = action;
    reviewDecisionFailure = null;

    try {
      const result = await querySelectedTaskReviewDecisionApply(
        projectId,
        taskId,
        action,
        selectedTask.revision_id,
        reason,
        reviewDecisionEvidenceRefs,
        reviewDecisionIdempotencyKey("apply", action, selectedTask.revision_id),
      );

      if (result.state !== "record") {
        reviewDecisionFailure = reviewDecisionFallbackMessage(result);
        return;
      }

      reviewDecisionApplyResult = result.record;
      await loadDrilldown();
    } catch (error) {
      reviewDecisionFailure = error instanceof Error ? error.message : String(error);
    } finally {
      reviewDecisionPending = null;
    }
  }

  $effect(() => {
    if (
      awaitingTaskRefresh &&
      (!selectedTask || selectedTask.revision_id !== lastCommandRevision)
    ) {
      awaitingTaskRefresh = false;
      lastCommandRevision = null;
    }
  });

  function noEffectFlags(record: ControlTaskWorkflowDrilldownDto): [string, boolean][] {
    return [
      ["task mutation", record.no_effects.task_mutation_performed],
      ["provider run", record.no_effects.provider_execution_performed],
      ["provider write", record.no_effects.provider_write_performed],
      ["SCM or forge change", record.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", record.no_effects.accepted_memory_apply_performed],
      ["planning apply", record.no_effects.planning_apply_performed],
      ["projection write", record.no_effects.projection_write_performed],
      ["agent scheduling", record.no_effects.agent_scheduling_performed],
      ["UI state change", record.no_effects.ui_effect_performed],
    ];
  }

  function reviewNextNoEffectFlags(): [string, boolean][] {
    if (!reviewNext) {
      return [];
    }

    return [
      ["review mutation", reviewNext.no_effects.review_mutation_performed],
      ["task mutation", reviewNext.no_effects.task_mutation_performed],
      ["provider run", reviewNext.no_effects.provider_execution_performed],
      ["SCM or forge change", reviewNext.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", reviewNext.no_effects.accepted_memory_apply_performed],
      ["planning apply", reviewNext.no_effects.planning_apply_performed],
      ["UI state change", reviewNext.no_effects.ui_effect_performed],
    ];
  }

  function reviewOutcomeRouteNoEffectFlags(): [string, boolean][] {
    if (!reviewOutcomeRoute) {
      return [];
    }

    return [
      ["review mutation", reviewOutcomeRoute.no_effects.review_mutation_performed],
      ["task mutation", reviewOutcomeRoute.no_effects.task_lifecycle_mutation_performed],
      ["provider run", reviewOutcomeRoute.no_effects.provider_execution_performed],
      ["provider write", reviewOutcomeRoute.no_effects.provider_write_performed],
      ["SCM or forge change", reviewOutcomeRoute.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", reviewOutcomeRoute.no_effects.accepted_memory_apply_performed],
      ["planning apply", reviewOutcomeRoute.no_effects.planning_apply_performed],
      ["projection write", reviewOutcomeRoute.no_effects.projection_write_performed],
      ["agent scheduling", reviewOutcomeRoute.no_effects.agent_scheduling_performed],
      ["UI state change", reviewOutcomeRoute.no_effects.ui_effect_performed],
    ];
  }

  function routeAdmissionNoEffectFlags(): [string, boolean][] {
    if (!routeAdmission) {
      return [];
    }

    return [
      ["review mutation", routeAdmission.no_effects.review_mutation_performed],
      ["task mutation", routeAdmission.no_effects.task_lifecycle_mutation_performed],
      ["provider run", routeAdmission.no_effects.provider_execution_performed],
      ["provider write", routeAdmission.no_effects.provider_write_performed],
      ["SCM or forge change", routeAdmission.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", routeAdmission.no_effects.accepted_memory_apply_performed],
      ["planning apply", routeAdmission.no_effects.planning_apply_performed],
      ["projection write", routeAdmission.no_effects.projection_write_performed],
      ["agent scheduling", routeAdmission.no_effects.agent_scheduling_performed],
      ["UI state change", routeAdmission.no_effects.ui_effect_performed],
    ];
  }

  function scmHandoffNoEffectFlags(): [string, boolean][] {
    if (!scmHandoff) {
      return [];
    }

    return [
      ["SCM mutation", scmHandoff.no_effects.scm_mutation_performed],
      ["forge mutation", scmHandoff.no_effects.forge_mutation_performed],
      ["credential resolution", scmHandoff.no_effects.credential_resolution_performed],
      ["task mutation", scmHandoff.no_effects.task_mutation_performed],
      ["provider run", scmHandoff.no_effects.provider_execution_performed],
      ["review mutation", scmHandoff.no_effects.review_mutation_performed],
      ["memory apply", scmHandoff.no_effects.accepted_memory_apply_performed],
      ["planning apply", scmHandoff.no_effects.planning_apply_performed],
      ["projection write", scmHandoff.no_effects.projection_write_performed],
      ["UI state change", scmHandoff.no_effects.ui_effect_performed],
    ];
  }

  function reviewDecisionNoEffectFlags(
    admission: ControlSelectedTaskReviewDecisionAdmissionDto,
  ): [string, boolean][] {
    return [
      ["review mutation", admission.no_effects.review_mutation_performed],
      ["task mutation", admission.no_effects.task_mutation_performed],
      ["provider run", admission.no_effects.provider_execution_performed],
      ["SCM or forge change", admission.no_effects.scm_or_forge_mutation_performed],
      ["memory apply", admission.no_effects.accepted_memory_apply_performed],
      ["planning apply", admission.no_effects.planning_apply_performed],
      ["UI state change", admission.no_effects.ui_effect_performed],
    ];
  }

  function reviewDecisionReasonRequired(action: SelectedTaskReviewDecisionAction) {
    return action === "reject_evidence" || action === "request_changes" || action === "abandon_review";
  }

  function reviewDecisionLabel(action: SelectedTaskReviewDecisionAction) {
    return action.replaceAll("_", " ");
  }

  function reviewDecisionCanApply(action: SelectedTaskReviewDecisionAction) {
    const admission = reviewDecisionAdmissions[action];
    return Boolean(selectedTask && admission?.status === "admitted" && admission.command);
  }

  function reviewDecisionIdempotencyKey(
    mode: "preview" | "apply",
    action: SelectedTaskReviewDecisionAction,
    revision: string | null,
  ) {
    return `${mode}:desktop:${taskId}:${action}:${revision ?? "no-revision"}`;
  }

  function gapReason(gaps: ControlTaskWorkflowGapDto[], area: string) {
    return (
      gaps.find((gap) => gap.area === area || gap.area === `${area}_missing`)?.reason ??
      "source refs present"
    );
  }

  function guidanceLabel(source: string, action: string) {
    return `${action.replaceAll("_", " ")} from ${source.replaceAll("_", " ")}`;
  }

  function selectedContextLabel(record: ControlTaskWorkflowDrilldownDto) {
    return `${record.project_id} / ${record.task_id}`;
  }

  function actionLabel(action: ControlSelectedTaskActionDto) {
    return action.label || action.family.replaceAll("_", " ");
  }

  function gateCandidateLabel(candidate: ControlSelectedTaskOperatorActionCandidateDto) {
    return candidate.label || candidate.family.replaceAll("_", " ");
  }

  function gateCommandLabel(candidate: ControlSelectedTaskOperatorActionCandidateDto) {
    return candidate.task_command?.action ?? candidate.disposition.replaceAll("_", " ");
  }

  function fallbackMessage(value: TaskWorkflowDrilldownQueryResult | null) {
    if (!value) {
      return "No response.";
    }

    switch (value.state) {
      case "record":
        return null;
      case "empty":
        return "No records.";
      case "unsupported":
        return value.reason;
      case "error":
        return `${value.kind}: ${value.reason}`;
      case "unexpected":
        return value.reason;
    }
  }

  function admissionFallbackMessage(value: Exclude<Awaited<ReturnType<typeof querySelectedTaskCommandAdmission>>, { state: "record" }>) {
    switch (value.state) {
      case "empty":
        return "Selected task command admission returned no record.";
      case "unsupported":
        return value.reason;
      case "error":
        return `${value.kind}: ${value.reason}`;
      case "unexpected":
        return value.reason;
    }
  }

  function reviewDecisionFallbackMessage(
    value: Exclude<Awaited<ReturnType<typeof querySelectedTaskReviewDecisionApply>>, { state: "record" }>,
  ) {
    switch (value.state) {
      case "empty":
        return "Selected task review decision returned no record.";
      case "unsupported":
        return value.reason;
      case "error":
        return `${value.kind}: ${value.reason}`;
      case "unexpected":
        return value.reason;
    }
  }

  $effect(() => {
    void projectId;
    void taskId;
    void loadDrilldown();
  });
</script>

<Surface>
  <section class="task-workflow-drilldown-proof-panel" aria-label="Task Workflow Drilldown Proof">
    <div class="panel-head">
      <div class="panel-copy">
        <h2>Task workflow</h2>
        <Text tone="muted">Selected task proof controls.</Text>
      </div>
      <StatusIndicator status={statusTone} label={statusLabel} />
    </div>

    {#if failure}
      <div class="panel-message panel-message-error">
        <Text tone="danger">{failure}</Text>
      </div>
    {:else if loading}
      <div class="panel-message">
        <Text tone="muted">Loading task workflow.</Text>
      </div>
    {:else if drilldown}
      <div class="work-loop-guidance" aria-label="Work-loop guidance">
        <div>
          <h3>Work-loop guidance</h3>
          <p>{drilldown.guidance.reason}</p>
          {#if drilldown.guidance.blocked_reason}
            <small>{drilldown.guidance.blocked_reason}</small>
          {:else}
            <small>{guidanceLabel(drilldown.guidance.source, drilldown.guidance.safe_action)}</small>
          {/if}
        </div>
        <dl>
          <div>
            <dt>Selected</dt>
            <dd>{selectedContextLabel(drilldown)}</dd>
          </div>
          <div>
            <dt>Project lane</dt>
            <dd>{selectedLane?.lane ?? "not in project lane"}</dd>
          </div>
          <div>
            <dt>Project next</dt>
            <dd>{workflowSummary?.next.next_ref ?? workflowSummary?.next.source ?? "unavailable"}</dd>
          </div>
          <div>
            <dt>Evidence refs</dt>
            <dd>{drilldown.guidance.evidence_refs.length}</dd>
          </div>
        </dl>
      </div>

      <div class="drilldown-identity">
        <div>
          <span>{drilldown.task?.title ?? drilldown.task_id}</span>
          <small>{drilldown.task?.activity ?? "missing task"}</small>
        </div>
        <div>
          <span>{drilldown.readiness?.lane ?? "none"}</span>
          <small>lane</small>
        </div>
        <div>
          <span>{drilldown.gaps.length}</span>
          <small>gaps</small>
        </div>
        <div>
          <span>{noEffects ? "none" : "check"}</span>
          <small>effects</small>
        </div>
      </div>

      <div class="selected-task-context" aria-label="Selected task context">
        <section>
          <h3>Task</h3>
          <dl>
            <div>
              <dt>Action</dt>
              <dd>{drilldown.task?.action_type ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Assignment</dt>
              <dd>{drilldown.task?.assignment ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Activity</dt>
              <dd>{drilldown.task?.activity ?? "unknown"}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Project workflow</h3>
          <dl>
            <div>
              <dt>Project</dt>
              <dd>{workflowSummary?.project.display_name ?? drilldown.project_id}</dd>
            </div>
            <div>
              <dt>Lane count</dt>
              <dd>{selectedLane?.count ?? 0}</dd>
            </div>
            <div>
              <dt>Workflow gaps</dt>
              <dd>{workflowSummary?.gaps.length ?? "unavailable"}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div class="review-handoff-readiness" aria-label="Review and handoff readiness">
        <section>
          <h3>Review readiness</h3>
          <p>{gapReason(drilldown.gaps, "review")}</p>
          <dl>
            <div>
              <dt>Review refs</dt>
              <dd>{drilldown.review.review_refs.length}</dd>
            </div>
            <div>
              <dt>Safe action</dt>
              <dd>
                {drilldown.guidance.source === "review"
                  ? drilldown.guidance.safe_action.replaceAll("_", " ")
                  : "inspect evidence"}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Handoff readiness</h3>
          <p>{gapReason(drilldown.gaps, "scm_handoff")}</p>
          <dl>
            <div>
              <dt>Handoff refs</dt>
              <dd>{drilldown.scm_handoff.handoff_refs.length}</dd>
            </div>
            <div>
              <dt>Safe action</dt>
              <dd>
                {drilldown.guidance.source === "scm_handoff"
                  ? drilldown.guidance.safe_action.replaceAll("_", " ")
                  : "inspect readiness"}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {#if reviewNext}
        <div class="selected-task-review-next" aria-label="Selected task review next">
          <section>
            <h3>Review state</h3>
            <p>{reviewNext.review.reason}</p>
            <dl>
              <div>
                <dt>State</dt>
                <dd>{reviewNext.review.state.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Reviewable work</dt>
                <dd>{reviewNext.review.work_item_refs.length}</dd>
              </div>
              <div>
                <dt>Evidence refs</dt>
                <dd>{reviewNext.review.evidence_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Review evidence boundary</h3>
            <dl>
              <div>
                <dt>Receipts</dt>
                <dd>{reviewNext.evidence.receipt_refs.length}</dd>
              </div>
              <div>
                <dt>Checkpoints</dt>
                <dd>{reviewNext.evidence.checkpoint_refs.length}</dd>
              </div>
              <div>
                <dt>Diffs</dt>
                <dd>{reviewNext.evidence.diff_summary_refs.length}</dd>
              </div>
              <div>
                <dt>Validation</dt>
                <dd>{reviewNext.evidence.validation_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Pathway-backed next step</h3>
            <p>{reviewNext.next.summary}</p>
            <dl>
              <div>
                <dt>Category</dt>
                <dd>{reviewNext.next.category.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Next ref</dt>
                <dd>{reviewNext.next.next_ref ?? "none"}</dd>
              </div>
              <div>
                <dt>Rationale refs</dt>
                <dd>{reviewNext.next.rationale_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Review gaps</h3>
            {#if reviewNext.gaps.length > 0}
              {#each reviewNext.gaps as gap}
                <article>
                  <strong>{gap.area.replaceAll("_", " ")}</strong>
                  <span>{gap.reason}</span>
                </article>
              {/each}
            {:else}
              <p>No review-next gaps.</p>
            {/if}
          </section>
        </div>

        <div class="selected-task-review-next-counts" aria-label="Selected task review next counts">
          <span>work {reviewNext.source_counts.work_items}</span>
          <span>completed {reviewNext.source_counts.completed_work_items}</span>
          <span>reviewable {reviewNext.source_counts.reviewable_work_items}</span>
          <span>timeline refs {reviewNext.source_counts.timeline_refs}</span>
          <span>review refs {reviewNext.source_counts.review_refs}</span>
          <span>gaps {reviewNext.source_counts.gap_count}</span>
        </div>

        <div class="selected-task-review-next-no-effects" aria-label="Selected task review next no-effect flags">
          {#each reviewNextNoEffectFlags() as [label, value]}
            <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
          {/each}
        </div>

        <div class="selected-task-review-decision" aria-label="Selected task review decision controls">
          <section>
            <h3>Review decision controls</h3>
            <p>{reviewNext.review.reason}</p>
            <div class="review-decision-reason-field">
              <label for="selected-task-review-decision-reason">Decision reason</label>
              <input
                id="selected-task-review-decision-reason"
                type="text"
                bind:value={reviewDecisionReason}
                placeholder="Required for changes, reject, abandon"
                disabled={Boolean(reviewDecisionPending)}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => void refreshReviewDecisionAdmissions()}
              disabled={Boolean(reviewDecisionPending)}
            >
              Preview decisions
            </Button>
          </section>

          {#each reviewDecisionActions as action}
            {@const admission = reviewDecisionAdmissions[action]}
            <section>
              <h3>{reviewDecisionLabel(action)}</h3>
              <p>{admission?.refusal?.reason ?? admission?.command?.outcome ?? "not previewed"}</p>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{admission?.status ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Evidence refs</dt>
                  <dd>{admission?.evidence_refs.length ?? reviewDecisionEvidenceRefs.length}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{reviewDecisionReasonRequired(action) ? "required" : "optional"}</dd>
                </div>
              </dl>
              {#if admission}
                <div class="selected-task-review-decision-no-effects" aria-label="Selected task review decision no-effect flags">
                  {#each reviewDecisionNoEffectFlags(admission) as [label, value]}
                    <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
                  {/each}
                </div>
              {/if}
              <Button
                variant="secondary"
                onClick={() => void submitReviewDecision(action)}
                disabled={!reviewDecisionCanApply(action) ||
                  Boolean(reviewDecisionPending) ||
                  (reviewDecisionReasonRequired(action) && !reviewDecisionReason.trim())}
              >
                {reviewDecisionPending === action ? "Applying" : `Apply ${reviewDecisionLabel(action)}`}
              </Button>
            </section>
          {/each}
        </div>

        {#if reviewDecisionFailure}
          <div class="panel-message panel-message-error">
            <Text tone="danger">{reviewDecisionFailure}</Text>
          </div>
        {/if}

        {#if reviewDecisionApplyResult}
          <div class="selected-task-review-decision-result" aria-label="Selected task review decision result">
            <section>
              <h3>Decision receipt</h3>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{reviewDecisionApplyResult.status}</dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{reviewDecisionApplyResult.outcome}</dd>
                </div>
                <div>
                  <dt>Decision</dt>
                  <dd>{reviewDecisionApplyResult.decision_id}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>Server blockers</h3>
              {#if reviewDecisionApplyResult.blockers.length > 0}
                {#each reviewDecisionApplyResult.blockers as blocker}
                  <span>{blocker.replaceAll("_", " ")}</span>
                {/each}
              {:else}
                <span>No blockers.</span>
              {/if}
            </section>
            <section>
              <h3>No-effect proof</h3>
              <span>review mutation {reviewDecisionApplyResult.review_mutation_performed ? "true" : "false"}</span>
              <span>task mutation {reviewDecisionApplyResult.task_lifecycle_mutation_performed ? "true" : "false"}</span>
              <span>provider run {reviewDecisionApplyResult.provider_execution_performed ? "true" : "false"}</span>
              <span>SCM change {reviewDecisionApplyResult.scm_or_forge_mutation_performed ? "true" : "false"}</span>
            </section>
          </div>
        {/if}
      {:else if reviewNextResult && reviewNextResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">Review next-step state unavailable.</Text>
        </div>
      {/if}

      {#if reviewOutcomeRoute}
        <div class="selected-task-review-outcome-route" aria-label="Selected task review outcome route">
          <section>
            <h3>Review outcome route</h3>
            <p>{reviewOutcomeRoute.primary_route.replaceAll("_", " ")}</p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{reviewOutcomeRoute.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Decision</dt>
                <dd>{reviewOutcomeRoute.decision_ref ?? "none"}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{reviewOutcomeRoute.decision_outcome?.replaceAll("_", " ") ?? "none"}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Route candidates</h3>
            {#if reviewOutcomeRoute.candidates.length > 0}
              {#each reviewOutcomeRoute.candidates as candidate}
                <span>{candidate.replaceAll("_", " ")}</span>
              {/each}
            {:else}
              <p>No route candidates.</p>
            {/if}
          </section>

          <section>
            <h3>Downstream hints</h3>
            {#if reviewOutcomeRoute.downstream_command_hints.length > 0}
              {#each reviewOutcomeRoute.downstream_command_hints as hint}
                <span>{hint.replaceAll("_", " ")}</span>
              {/each}
            {:else}
              <p>No downstream command hints.</p>
            {/if}
          </section>

          <section>
            <h3>Route blockers</h3>
            {#if reviewOutcomeRoute.blockers.length > 0}
              {#each reviewOutcomeRoute.blockers as blocker}
                <span>{blocker.replaceAll("_", " ")}</span>
              {/each}
            {:else}
              <p>No route blockers.</p>
            {/if}
          </section>
        </div>

        <div class="selected-task-review-outcome-route-counts" aria-label="Selected task review outcome route counts">
          <span>decisions {reviewOutcomeRoute.source_counts.decision_records}</span>
          <span>work refs {reviewOutcomeRoute.source_counts.work_item_refs}</span>
          <span>evidence {reviewOutcomeRoute.source_counts.evidence_refs}</span>
          <span>review gaps {reviewOutcomeRoute.source_counts.review_gap_count}</span>
          <span>handoff refs {reviewOutcomeRoute.source_counts.scm_handoff_refs}</span>
          <span>hints {reviewOutcomeRoute.source_counts.downstream_command_hints}</span>
          <span>blockers {reviewOutcomeRoute.source_counts.blockers}</span>
        </div>

        <div class="selected-task-review-outcome-route-no-effects" aria-label="Selected task review outcome route no-effect flags">
          {#each reviewOutcomeRouteNoEffectFlags() as [label, value]}
            <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
          {/each}
        </div>
      {:else if reviewOutcomeRouteResult && reviewOutcomeRouteResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">Review outcome route unavailable.</Text>
        </div>
      {/if}

      {#if routeAdmission}
        <div class="selected-task-route-admission" aria-label="Selected task route admission">
          <section>
            <h3>Completion admission preview</h3>
            <p>
              {routeAdmission.completion.refusal?.reason ??
                routeAdmission.completion.command_admission?.command?.action ??
                "no completion command"}
            </p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{routeAdmission.completion.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>{routeAdmission.completion.route_candidate.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Decision</dt>
                <dd>{routeAdmission.completion.decision_ref ?? "none"}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Rework and delegation previews</h3>
            <p>
              {routeAdmission.rework_delegation.refusal?.reason ??
                routeAdmission.rework_delegation.rework_preview?.summary ??
                routeAdmission.rework_delegation.delegation_preview?.summary ??
                "no rework or delegation preview"}
            </p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{routeAdmission.rework_delegation.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Rework</dt>
                <dd>{routeAdmission.rework_delegation.rework_preview?.family.replaceAll("_", " ") ?? "none"}</dd>
              </div>
              <div>
                <dt>Delegation</dt>
                <dd>{routeAdmission.rework_delegation.delegation_preview?.family.replaceAll("_", " ") ?? "none"}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Admission evidence</h3>
            <dl>
              <div>
                <dt>Completion refs</dt>
                <dd>{routeAdmission.completion.evidence_refs.length}</dd>
              </div>
              <div>
                <dt>Rework refs</dt>
                <dd>{routeAdmission.rework_delegation.evidence_refs.length}</dd>
              </div>
              <div>
                <dt>Work refs</dt>
                <dd>{routeAdmission.rework_delegation.work_item_refs.length}</dd>
              </div>
            </dl>
          </section>
        </div>

        <div class="selected-task-route-admission-no-effects" aria-label="Selected task route admission no-effect flags">
          {#each routeAdmissionNoEffectFlags() as [label, value]}
            <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
          {/each}
        </div>
      {:else if routeAdmissionResult && routeAdmissionResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">Selected task route admission unavailable.</Text>
        </div>
      {/if}

      {#if scmHandoff}
        <div class="selected-task-scm-handoff" aria-label="Selected task SCM handoff readiness">
          <section>
            <h3>SCM handoff readiness</h3>
            <p>{scmHandoff.readiness.reason}</p>
            <dl>
              <div>
                <dt>State</dt>
                <dd>{scmHandoff.readiness.state.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Handoff refs</dt>
                <dd>{scmHandoff.readiness.handoff_refs.length}</dd>
              </div>
              <div>
                <dt>Blocker refs</dt>
                <dd>{scmHandoff.readiness.blocker_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Target shape</h3>
            <p>{scmHandoff.target.shape.replaceAll("_", " ")}</p>
            <dl>
              <div>
                <dt>Target refs</dt>
                <dd>{scmHandoff.target.target_refs.length}</dd>
              </div>
              <div>
                <dt>Provider changes</dt>
                <dd>{scmHandoff.evidence.provider_change_refs.length}</dd>
              </div>
              <div>
                <dt>Work sessions</dt>
                <dd>{scmHandoff.evidence.scm_work_session_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Handoff evidence boundary</h3>
            <dl>
              <div>
                <dt>Checkpoints</dt>
                <dd>{scmHandoff.evidence.checkpoint_refs.length}</dd>
              </div>
              <div>
                <dt>Diffs</dt>
                <dd>{scmHandoff.evidence.diff_summary_refs.length}</dd>
              </div>
              <div>
                <dt>Receipts</dt>
                <dd>{scmHandoff.evidence.runtime_receipt_refs.length}</dd>
              </div>
              <div>
                <dt>Preparation refs</dt>
                <dd>{scmHandoff.evidence.change_request_prep_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Handoff next step</h3>
            <p>{scmHandoff.next.summary}</p>
            <dl>
              <div>
                <dt>Category</dt>
                <dd>{scmHandoff.next.category.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Next ref</dt>
                <dd>{scmHandoff.next.next_ref ?? "none"}</dd>
              </div>
              <div>
                <dt>Rationale refs</dt>
                <dd>{scmHandoff.next.rationale_refs.length}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>Handoff blockers</h3>
            {#if scmHandoff.gaps.length > 0}
              {#each scmHandoff.gaps as gap}
                <article>
                  <strong>{gap.area.replaceAll("_", " ")}</strong>
                  <span>{gap.reason}</span>
                </article>
              {/each}
            {:else}
              <p>No SCM handoff blockers.</p>
            {/if}
          </section>
        </div>

        <div class="selected-task-scm-handoff-counts" aria-label="Selected task SCM handoff counts">
          <span>work {scmHandoff.source_counts.work_items}</span>
          <span>handoff refs {scmHandoff.source_counts.scm_handoff_refs}</span>
          <span>work sessions {scmHandoff.source_counts.scm_work_session_refs}</span>
          <span>provider changes {scmHandoff.source_counts.provider_change_refs}</span>
          <span>prep refs {scmHandoff.source_counts.change_request_prep_refs}</span>
          <span>gaps {scmHandoff.source_counts.gap_count}</span>
        </div>

        <div class="selected-task-scm-handoff-no-effects" aria-label="Selected task SCM handoff no-effect flags">
          {#each scmHandoffNoEffectFlags() as [label, value]}
            <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
          {/each}
        </div>
      {:else if scmHandoffResult && scmHandoffResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">SCM handoff readiness unavailable.</Text>
        </div>
      {/if}

      {#if actionReadiness}
        <div class="action-readiness" aria-label="Selected task action readiness">
          <section>
            <h3>Allowed action affordances</h3>
            {#if allowedActions.length > 0}
              {#each allowedActions as action}
                <article>
                  <strong>{actionLabel(action)}</strong>
                  <span>{action.reason}</span>
                  <small>evidence refs {action.evidence_refs.length}</small>
                </article>
              {/each}
            {:else}
              <p>No allowed affordances.</p>
            {/if}
          </section>

          <section>
            <h3>Blocked action affordances</h3>
            {#if blockedActions.length > 0}
              {#each blockedActions as action}
                <article>
                  <strong>{actionLabel(action)}</strong>
                  <span>{action.reason}</span>
                  <small>blocker refs {action.blocker_refs.length}</small>
                </article>
              {/each}
            {:else}
              <p>No blocked affordances.</p>
            {/if}
          </section>

          <section>
            <h3>Other lanes</h3>
            {#if otherActions.length > 0}
              {#each otherActions as action}
                <article>
                  <strong>{actionLabel(action)}</strong>
                  <span>{action.status.replaceAll("_", " ")}: {action.reason}</span>
                  <small>evidence refs {action.evidence_refs.length}</small>
                </article>
              {/each}
            {:else}
              <p>No different-lane or not-applicable affordances.</p>
            {/if}
          </section>
        </div>

        <div class="action-readiness-counts" aria-label="Action readiness source counts">
          <span>actions {actionReadiness.actions.length}</span>
          <span>blockers {actionReadiness.blockers.length}</span>
          <span>active work {actionReadiness.source_counts.active_work_items}</span>
          <span>runtime refs {actionReadiness.source_counts.runtime_evidence_refs}</span>
          <span>review refs {actionReadiness.source_counts.review_refs}</span>
          <span>handoff refs {actionReadiness.source_counts.scm_handoff_refs}</span>
        </div>
      {:else if actionReadinessResult && actionReadinessResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">Action readiness unavailable.</Text>
        </div>
      {/if}

      {#if operatorGate}
        <div class="operator-action-gate" aria-label="Selected task operator action gate">
          <section>
            <h3>Task command candidates</h3>
            {#if taskCommandCandidates.length > 0}
              <div class="block-reason-field">
                <label for="selected-task-block-reason">Block reason</label>
                <input
                  id="selected-task-block-reason"
                  type="text"
                  bind:value={blockReason}
                  placeholder="Required before block"
                  disabled={Boolean(commandPending) || waitingForServerTaskRecord}
                />
              </div>
              {#each taskCommandCandidates as candidate}
                <article>
                  <strong>{gateCandidateLabel(candidate)}</strong>
                  <span>{candidate.reason}</span>
                  <small>
                    command {gateCommandLabel(candidate)}, revision
                    {candidate.expected_revision_required ? "required" : "not required"},
                    reason {candidate.reason_required ? "required" : "not required"}
                  </small>
                  <Button
                    variant="secondary"
                    onClick={() => void submitSelectedTaskCommand(candidate)}
                    disabled={!selectedTask ||
                      Boolean(commandPending) ||
                      waitingForServerTaskRecord ||
                      (candidate.reason_required && !blockReason.trim())}
                  >
                    {waitingForServerTaskRecord
                      ? "Refreshing"
                      : commandPending === candidate.family
                      ? "Submitting"
                      : `${gateCommandLabel(candidate)} task`}
                  </Button>
                </article>
              {/each}
            {:else}
              <p>No task command candidates.</p>
            {/if}
          </section>

          <section>
            <h3>Blocked operator actions</h3>
            {#if blockedGateCandidates.length > 0}
              {#each blockedGateCandidates as candidate}
                <article>
                  <strong>{gateCandidateLabel(candidate)}</strong>
                  <span>{candidate.reason}</span>
                  <small>blocker refs {candidate.blocker_refs.length}</small>
                </article>
              {/each}
            {:else}
              <p>No blocked operator actions.</p>
            {/if}
          </section>

          <section>
            <h3>Deferred and read-only actions</h3>
            {#if passiveGateCandidates.length > 0}
              {#each passiveGateCandidates as candidate}
                <article>
                  <strong>{gateCandidateLabel(candidate)}</strong>
                  <span>{candidate.disposition.replaceAll("_", " ")}: {candidate.reason}</span>
                  <small>task command none</small>
                </article>
              {/each}
            {:else}
              <p>No deferred or read-only actions.</p>
            {/if}
          </section>
        </div>

        <div class="operator-action-gate-counts" aria-label="Operator action gate counts">
          <span>candidates {operatorGate.source_counts.task_command_candidates}</span>
          <span>blocked {operatorGate.source_counts.blocked_actions}</span>
          <span>read-only {operatorGate.source_counts.read_only_actions}</span>
          <span>deferred {operatorGate.source_counts.deferred_actions}</span>
          <span>gate effects {operatorGate.no_effects.task_mutation_performed ? "check" : "none"}</span>
        </div>

        {#if lastAdmission}
          <div class="selected-task-command-admission" aria-label="Selected task command admission">
            <span>admission {lastAdmission.status}</span>
            <span>family {lastAdmission.family}</span>
            <span>command {lastAdmission.command?.action ?? "none"}</span>
            <span>task mutation proof {lastAdmission.no_effects.task_mutation_performed ? "check" : "none"}</span>
          </div>
        {/if}

        {#if commandReceipt}
          <div class="task-command-outcome-evidence" aria-label="Task command outcome evidence">
            <section>
              <h3>Command receipt</h3>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{commandReceipt.status}</dd>
                </div>
                <div>
                  <dt>Command</dt>
                  <dd>{commandReceipt.commandId}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{commandReceipt.action}</dd>
                </div>
                <div>
                  <dt>Submitted revision</dt>
                  <dd>{commandReceipt.submittedRevision}</dd>
                </div>
              </dl>
            </section>

            <section>
              <h3>Refreshed timeline evidence</h3>
              <p>{drilldown.source_counts.timeline_entry_refs} entries</p>
              <dl>
                <div>
                  <dt>Timeline refs</dt>
                  <dd>{receiptTimelineRefs.length}</dd>
                </div>
                <div>
                  <dt>Task activity</dt>
                  <dd>{drilldown.task?.activity ?? "unknown"}</dd>
                </div>
              </dl>
              {#if receiptTimelinePreview.length > 0}
                <div class="timeline-ref-list" aria-label="Task command timeline refs">
                  {#each receiptTimelinePreview as ref}
                    <span>{ref}</span>
                  {/each}
                  {#if receiptTimelineRefs.length > receiptTimelinePreview.length}
                    <span>{receiptTimelineRefs.length - receiptTimelinePreview.length} more</span>
                  {/if}
                </div>
              {:else}
                <small>{gapReason(drilldown.gaps, "timeline")}</small>
              {/if}
            </section>

            <section>
              <h3>Workflow evidence</h3>
              <dl>
                <div>
                  <dt>Guidance refs</dt>
                  <dd>{drilldown.guidance.evidence_refs.length}</dd>
                </div>
                <div>
                  <dt>Command refs</dt>
                  <dd>{drilldown.runtime.command_evidence_refs.length}</dd>
                </div>
                <div>
                  <dt>Receipt family</dt>
                  <dd>{commandReceipt.family}</dd>
                </div>
              </dl>
            </section>
          </div>
        {/if}

        {#if waitingForServerTaskRecord}
          <div class="panel-message">
            <Text tone="muted">Waiting for refreshed server task state.</Text>
          </div>
        {/if}
      {:else if operatorGateResult && operatorGateResult.state !== "record"}
        <div class="panel-message">
          <Text tone="muted">Operator action gate unavailable.</Text>
        </div>
      {/if}

      <div class="drilldown-sections">
        <section>
          <h3>Timeline</h3>
          <p>{drilldown.source_counts.timeline_entry_refs} entries</p>
          <small>{gapReason(drilldown.gaps, "timeline")}</small>
        </section>

        <section>
          <h3>Runtime</h3>
          <dl>
            <div>
              <dt>Receipts</dt>
              <dd>{drilldown.runtime.runtime_receipt_refs.length}</dd>
            </div>
            <div>
              <dt>Commands</dt>
              <dd>{drilldown.runtime.command_evidence_refs.length}</dd>
            </div>
            <div>
              <dt>Completions</dt>
              <dd>{drilldown.runtime.task_completion_refs.length}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Review and SCM</h3>
          <dl>
            <div>
              <dt>Reviews</dt>
              <dd>{drilldown.review.review_refs.length}</dd>
            </div>
            <div>
              <dt>Handoffs</dt>
              <dd>{drilldown.scm_handoff.handoff_refs.length}</dd>
            </div>
          </dl>
          <small>{gapReason(drilldown.gaps, "scm_handoff")}</small>
        </section>

        <section>
          <h3>Next</h3>
          <p>{drilldown.next.blocked_reason ?? drilldown.next.summary}</p>
          <small>{drilldown.next.next_ref ?? drilldown.next.source}</small>
        </section>
      </div>

      {#if drilldown.work_progress.work_items.length > 0}
        <div class="work-items" aria-label="Task workflow work items">
          {#each drilldown.work_progress.work_items as item}
            <div>
              <strong>{item.work_item_ref}</strong>
              <span>{item.runtime_status} / {item.review_status}</span>
              <small>
                receipts {item.receipt_refs.length}, checkpoints {item.checkpoint_refs.length},
                diffs {item.diff_summary_refs.length}
              </small>
            </div>
          {/each}
        </div>
      {:else}
        <div class="panel-message">
          <Text tone="muted">{gapReason(drilldown.gaps, "work_progress")}</Text>
        </div>
      {/if}

      <div class="drilldown-no-effects" aria-label="Task workflow no-effect flags">
        {#each noEffectFlags(drilldown) as [label, value]}
          <span class:flagged={value}>{label}: {value ? "true" : "false"}</span>
        {/each}
      </div>

      {#if drilldown.guidance.missing_evidence_areas.length > 0}
        <div class="guidance-missing" aria-label="Guidance missing evidence">
          {#each drilldown.guidance.missing_evidence_areas as area}
            <span>{area.replaceAll("_", " ")}</span>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="panel-message">
        <Text tone="muted">{fallbackMessage(result)}</Text>
      </div>
    {/if}

    <div class="panel-actions">
      <Text tone="muted">{selectedTask ? selectedTask.task_id : "Bootstrap task"}</Text>
      <Button variant="secondary" leadingIcon={refreshCw} onClick={loadDrilldown} disabled={loading}>
        Refresh
      </Button>
    </div>
  </section>
</Surface>

<style>
  .task-workflow-drilldown-proof-panel {
    display: grid;
    gap: var(--poodle-space-stack-md);
    min-width: 0;
  }

  .drilldown-identity,
  .drilldown-sections,
  .action-readiness,
  .operator-action-gate,
  .task-command-outcome-evidence,
  .selected-task-review-next,
  .selected-task-review-outcome-route,
  .selected-task-route-admission,
  .selected-task-review-decision,
  .selected-task-review-decision-result,
  .selected-task-scm-handoff,
  .selected-task-context,
  .review-handoff-readiness {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .work-loop-guidance,
  .drilldown-identity div,
  .drilldown-sections section,
  .action-readiness section,
  .operator-action-gate section,
  .task-command-outcome-evidence section,
  .selected-task-review-next section,
  .selected-task-review-outcome-route section,
  .selected-task-route-admission section,
  .selected-task-review-decision section,
  .selected-task-review-decision-result section,
  .selected-task-scm-handoff section,
  .selected-task-context section,
  .review-handoff-readiness section,
  .work-items div {
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-canvas);
  }

  .work-loop-guidance {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 0.75rem;
  }

  .work-loop-guidance h3,
  .action-readiness h3,
  .operator-action-gate h3,
  .selected-task-review-next h3,
  .selected-task-review-outcome-route h3,
  .selected-task-route-admission h3,
  .selected-task-review-decision h3,
  .selected-task-review-decision-result h3,
  .selected-task-scm-handoff h3,
  .selected-task-context h3,
  .review-handoff-readiness h3 {
    margin: 0 0 0.45rem;
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
    letter-spacing: 0;
  }

  .work-loop-guidance p {
    margin: 0 0 0.35rem;
    color: var(--poodle-color-text-primary);
  }

  .review-handoff-readiness p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .selected-task-review-next p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .selected-task-review-outcome-route p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .selected-task-route-admission p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .selected-task-review-decision p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .selected-task-scm-handoff p {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.78rem;
  }

  .action-readiness {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .operator-action-gate {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .task-command-outcome-evidence {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .selected-task-review-next {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .selected-task-review-outcome-route {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .selected-task-route-admission {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .selected-task-review-decision {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .selected-task-review-decision-result {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .selected-task-scm-handoff {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .action-readiness article {
    display: grid;
    gap: 0.2rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--poodle-color-border-subtle);
  }

  .action-readiness article:first-of-type {
    border-top: 0;
  }

  .operator-action-gate article {
    display: grid;
    gap: 0.2rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--poodle-color-border-subtle);
  }

  .selected-task-review-next article {
    display: grid;
    gap: 0.2rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--poodle-color-border-subtle);
  }

  .selected-task-review-next article:first-of-type {
    border-top: 0;
  }

  .selected-task-scm-handoff article {
    display: grid;
    gap: 0.2rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--poodle-color-border-subtle);
  }

  .selected-task-scm-handoff article:first-of-type {
    border-top: 0;
  }

  .operator-action-gate article:first-of-type {
    border-top: 0;
  }

  .action-readiness strong {
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .operator-action-gate strong {
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-task-review-next strong {
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-task-scm-handoff strong {
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-readiness span,
  .action-readiness p,
  .action-readiness small {
    margin: 0;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .operator-action-gate span,
  .selected-task-review-next span,
  .selected-task-review-outcome-route span,
  .selected-task-review-decision span,
  .selected-task-review-decision-result span,
  .selected-task-scm-handoff span,
  .operator-action-gate p,
  .operator-action-gate small,
  .task-command-outcome-evidence p,
  .task-command-outcome-evidence small {
    margin: 0;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .task-command-outcome-evidence h3 {
    margin: 0 0 0.45rem;
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
    letter-spacing: 0;
  }

  .block-reason-field {
    display: grid;
    gap: 0.25rem;
    margin: 0 0 0.5rem;
  }

  .review-decision-reason-field {
    display: grid;
    gap: 0.25rem;
    margin: 0 0 0.5rem;
  }

  .review-decision-reason-field label {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .review-decision-reason-field input {
    min-width: 0;
    padding: 0.45rem 0.5rem;
    color: var(--poodle-color-text-primary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .block-reason-field label {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .block-reason-field input {
    min-width: 0;
    padding: 0.45rem 0.5rem;
    color: var(--poodle-color-text-primary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-surface);
  }

  .work-loop-guidance small {
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .drilldown-identity span,
  .work-items strong {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drilldown-identity small,
  .drilldown-sections small,
  .work-items small {
    display: block;
    overflow: hidden;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drilldown-sections h3 {
    margin: 0 0 0.5rem;
    color: var(--poodle-color-text-primary);
    font-size: 0.8125rem;
    letter-spacing: 0;
  }

  .drilldown-sections p {
    margin: 0 0 0.35rem;
    color: var(--poodle-color-text-primary);
  }

  .drilldown-sections dl {
    display: grid;
    gap: 0.35rem;
    margin: 0 0 0.5rem;
  }

  .work-loop-guidance dl,
  .task-command-outcome-evidence dl,
  .selected-task-review-next dl,
  .selected-task-review-outcome-route dl,
  .selected-task-route-admission dl,
  .selected-task-scm-handoff dl,
  .selected-task-context dl,
  .review-handoff-readiness dl {
    display: grid;
    gap: 0.35rem;
    margin: 0;
  }

  .work-loop-guidance dl div,
  .task-command-outcome-evidence dl div,
  .selected-task-review-next dl div,
  .selected-task-review-outcome-route dl div,
  .selected-task-route-admission dl div,
  .selected-task-scm-handoff dl div,
  .review-handoff-readiness dl div,
  .drilldown-sections dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .selected-task-context dl div {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  .work-loop-guidance dt,
  .work-loop-guidance dd,
  .task-command-outcome-evidence dt,
  .task-command-outcome-evidence dd,
  .selected-task-review-next dt,
  .selected-task-review-next dd,
  .selected-task-review-outcome-route dt,
  .selected-task-review-outcome-route dd,
  .selected-task-route-admission dt,
  .selected-task-route-admission dd,
  .selected-task-scm-handoff dt,
  .selected-task-scm-handoff dd,
  .selected-task-context dt,
  .selected-task-context dd,
  .review-handoff-readiness dt,
  .review-handoff-readiness dd,
  .drilldown-sections dt,
  .drilldown-sections dd {
    margin: 0;
    color: var(--poodle-color-text-secondary);
    font-size: 0.75rem;
  }

  .work-loop-guidance dd,
  .task-command-outcome-evidence dd,
  .selected-task-review-next dd,
  .selected-task-review-outcome-route dd,
  .selected-task-route-admission dd,
  .selected-task-scm-handoff dd,
  .selected-task-context dd,
  .review-handoff-readiness dd {
    overflow: hidden;
    color: var(--poodle-color-text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .work-items {
    display: grid;
    gap: 0.5rem;
  }

  .work-items div {
    display: grid;
    gap: 0.25rem;
  }

  .work-items span {
    color: var(--poodle-color-text-secondary);
    font-size: 0.8rem;
  }

  .drilldown-no-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .action-readiness-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .operator-action-gate-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .selected-task-review-next-counts,
  .selected-task-review-next-no-effects,
  .selected-task-review-outcome-route-counts,
  .selected-task-review-outcome-route-no-effects,
  .selected-task-route-admission-no-effects,
  .selected-task-review-decision-no-effects,
  .selected-task-scm-handoff-counts,
  .selected-task-scm-handoff-no-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .selected-task-command-admission {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .operator-action-gate-counts span,
  .selected-task-command-admission span,
  .selected-task-review-next-counts span,
  .selected-task-review-next-no-effects span,
  .selected-task-review-outcome-route-counts span,
  .selected-task-review-outcome-route-no-effects span,
  .selected-task-route-admission-no-effects span,
  .selected-task-review-decision-no-effects span,
  .selected-task-scm-handoff-counts span,
  .selected-task-scm-handoff-no-effects span {
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .action-readiness-counts span {
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .guidance-missing {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .timeline-ref-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .guidance-missing span {
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .drilldown-no-effects span {
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .timeline-ref-list span {
    max-width: 100%;
    overflow: hidden;
    padding: 0.25rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: var(--poodle-color-background-canvas);
  }

  .drilldown-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  .selected-task-review-next-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  .selected-task-review-outcome-route-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  .selected-task-route-admission-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  .selected-task-review-decision-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  .selected-task-scm-handoff-no-effects span.flagged {
    color: var(--poodle-color-status-danger);
    border-color: var(--poodle-color-status-danger);
  }

  @media (max-width: 980px) {
    .work-loop-guidance,
    .drilldown-identity,
    .drilldown-sections,
    .action-readiness,
    .operator-action-gate,
    .task-command-outcome-evidence,
    .selected-task-review-next,
    .selected-task-review-outcome-route,
    .selected-task-route-admission,
    .selected-task-review-decision,
    .selected-task-review-decision-result,
    .selected-task-scm-handoff,
    .selected-task-context,
    .review-handoff-readiness {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
