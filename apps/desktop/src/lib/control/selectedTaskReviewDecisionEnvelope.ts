import type {
  ControlSelectedTaskReviewDecisionAdmissionDto,
  ControlSelectedTaskReviewDecisionRecordDto,
  SelectedTaskReviewDecisionAction,
} from "./selectedTaskReviewDecision";

export type ControlSelectedTaskReviewDecisionQueryDto =
  | {
      kind: "selected_task_review_decision_admission";
      query_id: string;
      action: "dry_run";
      project_id: string;
      task_id: string;
      decision_action: SelectedTaskReviewDecisionAction;
      expected_revision: string | null;
      current_revision: string | null;
      reason: string | null;
      operator_ref: string;
      reviewed_evidence_refs: string[];
      idempotency_key: string;
    }
  | {
      kind: "selected_task_review_decision_apply";
      query_id: string;
      action: "apply";
      project_id: string;
      task_id: string;
      decision_action: SelectedTaskReviewDecisionAction;
      expected_revision: string | null;
      current_revision: string | null;
      reason: string | null;
      operator_ref: string;
      reviewed_evidence_refs: string[];
      idempotency_key: string;
    };

export type ControlSelectedTaskReviewDecisionResponseBodyDto =
  | {
      type: "selected_task_review_decision_admission";
      admission: ControlSelectedTaskReviewDecisionAdmissionDto;
    }
  | {
      type: "selected_task_review_decision_apply";
      record: ControlSelectedTaskReviewDecisionRecordDto;
    };
