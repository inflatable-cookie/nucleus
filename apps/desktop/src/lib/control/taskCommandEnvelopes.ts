import {
  buildControlCommandEnvelope,
  buildControlQueryEnvelope,
  type ControlRequestEnvelopeDto,
} from "./envelopes";
import { CONTROL_CLIENT_ID, type ControlTaskRecordDto, type ControlTaskTransitionAction } from "./types";

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
