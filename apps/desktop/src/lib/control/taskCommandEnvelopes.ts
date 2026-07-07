import {
  buildControlCommandEnvelope,
  buildControlQueryEnvelope,
  type ControlRequestEnvelopeDto,
} from "./envelopes";
import type { SelectedTaskReviewDecisionAction } from "./selectedTaskReviewDecision";
import {
  CONTROL_CLIENT_ID,
  type ControlTaskRecordDto,
  type ControlTaskTransitionAction,
} from "./types";

export function buildTaskWorkflowDrilldownQuery(
  projectId: string,
  taskId: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "task_workflow_drilldown",
    query_id: "",
    action: "drilldown",
    project_id: projectId,
    task_id: taskId,
  });
}

export function buildSelectedTaskActionReadinessQuery(
  projectId: string,
  taskId: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_action_readiness",
    query_id: "",
    action: "readiness",
    project_id: projectId,
    task_id: taskId,
  });
}

export function buildSelectedTaskOperatorActionGateQuery(
  projectId: string,
  taskId: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_operator_action_gate",
    query_id: "",
    action: "gate",
    project_id: projectId,
    task_id: taskId,
  });
}

export function buildSelectedTaskReviewNextQuery(
  projectId: string,
  taskId: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_review_next",
    query_id: "",
    action: "review_next",
    project_id: projectId,
    task_id: taskId,
  });
}

export function buildSelectedTaskScmHandoffQuery(
  projectId: string,
  taskId: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_scm_handoff",
    query_id: "",
    action: "handoff",
    project_id: projectId,
    task_id: taskId,
  });
}

export function buildSelectedTaskCommandAdmissionQuery(
  projectId: string,
  taskId: string,
  family: string,
  expectedRevision: string | null,
  reason: string | null,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_command_admission",
    query_id: "",
    action: "dry_run",
    project_id: projectId,
    task_id: taskId,
    family,
    expected_revision: expectedRevision,
    reason,
    operator_ref: CONTROL_CLIENT_ID,
  });
}

export function buildSelectedTaskReviewDecisionAdmissionQuery(
  projectId: string,
  taskId: string,
  action: SelectedTaskReviewDecisionAction,
  expectedRevision: string | null,
  reason: string | null,
  reviewedEvidenceRefs: string[],
  idempotencyKey: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_review_decision_admission",
    query_id: "",
    action: "dry_run",
    project_id: projectId,
    task_id: taskId,
    decision_action: action,
    expected_revision: expectedRevision,
    current_revision: expectedRevision,
    reason,
    operator_ref: CONTROL_CLIENT_ID,
    reviewed_evidence_refs: reviewedEvidenceRefs,
    idempotency_key: idempotencyKey,
  });
}

export function buildSelectedTaskReviewDecisionApplyQuery(
  projectId: string,
  taskId: string,
  action: SelectedTaskReviewDecisionAction,
  expectedRevision: string | null,
  reason: string | null,
  reviewedEvidenceRefs: string[],
  idempotencyKey: string,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_review_decision_apply",
    query_id: "",
    action: "apply",
    project_id: projectId,
    task_id: taskId,
    decision_action: action,
    expected_revision: expectedRevision,
    current_revision: expectedRevision,
    reason,
    operator_ref: CONTROL_CLIENT_ID,
    reviewed_evidence_refs: reviewedEvidenceRefs,
    idempotency_key: idempotencyKey,
  });
}

export function buildTaskTransitionCommand(
  task: ControlTaskRecordDto,
  action: ControlTaskTransitionAction,
  reason: string | null = null,
): ControlRequestEnvelopeDto {
  return buildControlCommandEnvelope({
    kind: "task",
    command_id: "",
    action,
    task_id: task.task_id,
    expected_revision: task.revision_id,
    reason,
  });
}

export function buildStartTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "start");
}

export function buildBlockTaskCommand(
  task: ControlTaskRecordDto,
  reason: string,
): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "block", reason);
}

export function buildCompleteTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "complete");
}

export function buildArchiveTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "archive");
}
