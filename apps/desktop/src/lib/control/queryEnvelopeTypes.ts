import type {
  ControlStateDomain,
  DiagnosticsDomain,
  ProviderReadIntentAction,
  ProviderReadinessOverviewAction,
  RuntimeMetadataAction,
} from "./types";
import type { ControlSelectedTaskReviewDecisionQueryDto } from "./selectedTaskReviewDecisionEnvelope";

export type ControlQueryDto =
  | {
      kind: "runtime_metadata";
      query_id: string;
      action: RuntimeMetadataAction;
    }
  | {
      kind: "state";
      query_id: string;
      domain: ControlStateDomain;
      scope: { type: "list" };
    }
  | {
      kind: "diagnostics";
      query_id: string;
      domain: DiagnosticsDomain;
    }
  | {
      kind: "provider_read_intent";
      query_id: string;
      action: ProviderReadIntentAction;
    }
  | {
      kind: "provider_readiness_overview";
      query_id: string;
      action: ProviderReadinessOverviewAction;
    }
  | {
      kind: "planning_sessions" | "memory_proposals" | "research_run_briefs";
      query_id: string;
      action: "sessions" | "proposals" | "runs";
      project_id: string;
    }
  | {
      kind: "product_workflow_summary";
      query_id: string;
      action: "summary";
      project_id: string;
    }
  | {
      kind: "task_workflow_drilldown";
      query_id: string;
      action: "drilldown";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_action_readiness";
      query_id: string;
      action: "readiness";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_operator_action_gate";
      query_id: string;
      action: "gate";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_review_next";
      query_id: string;
      action: "review_next";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_review_outcome_route";
      query_id: string;
      action: "route";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_route_admission";
      query_id: string;
      action: "admission";
      project_id: string;
      task_id: string;
      expected_revision: string | null;
      operator_ref: string;
    }
  | {
      kind: "selected_task_completion_route_apply";
      query_id: string;
      action: "preview";
      project_id: string;
      task_id: string;
      expected_revision: string | null;
      operator_ref: string;
      route_admission_id: string | null;
      review_decision_ref: string | null;
      evidence_refs: string[];
    }
  | {
      kind: "selected_task_rework_preparation";
      query_id: string;
      action: "preview";
      project_id: string;
      task_id: string;
      operator_ref: string;
      route_admission_id: string | null;
      review_decision_ref: string | null;
      reviewed_work_item_refs: string[];
      reviewed_evidence_refs: string[];
      expected_task_revision: string | null;
      expected_work_item_revision: string | null;
    }
  | {
      kind: "selected_task_product_aggregate";
      query_id: string;
      action: "aggregate";
      project_id: string;
      task_id: string;
      expected_revision: string | null;
      operator_ref: string;
    }
  | {
      kind: "selected_task_scm_handoff";
      query_id: string;
      action: "handoff";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_command_admission";
      query_id: string;
      action: "dry_run";
      project_id: string;
      task_id: string;
      family: string;
      expected_revision: string | null;
      reason: string | null;
      operator_ref: string;
    }
  | ControlSelectedTaskReviewDecisionQueryDto;
