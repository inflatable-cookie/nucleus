use crate::control_api::{
    SelectedTaskActionReadinessQuery, SelectedTaskCommandAdmissionQuery,
    SelectedTaskOperatorActionGateQuery, SelectedTaskReviewDecisionAdmissionQuery,
    SelectedTaskReviewDecisionApplyQuery, SelectedTaskReviewNextQuery,
    SelectedTaskReviewOutcomeRouteQuery, SelectedTaskRouteAdmissionQuery,
    SelectedTaskScmHandoffQuery, ServerQueryKind,
};
use crate::control_envelope_dto::ControlApiCodecError;
use crate::ids::ServerQueryId;

use super::task_workflow::{
    selected_task_action_family_label, selected_task_review_decision_action_label,
};
use super::ControlQueryDto;

pub(super) fn selected_task_query_dto(
    query_id: &ServerQueryId,
    kind: &ServerQueryKind,
) -> Result<Option<ControlQueryDto>, ControlApiCodecError> {
    let dto = match kind {
        ServerQueryKind::SelectedTaskActionReadiness(SelectedTaskActionReadinessQuery {
            project_id,
            task_id,
        }) => ControlQueryDto::SelectedTaskActionReadiness {
            query_id: query_id.0.clone(),
            action: "readiness".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
        },
        ServerQueryKind::SelectedTaskOperatorActionGate(SelectedTaskOperatorActionGateQuery {
            project_id,
            task_id,
        }) => ControlQueryDto::SelectedTaskOperatorActionGate {
            query_id: query_id.0.clone(),
            action: "gate".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
        },
        ServerQueryKind::SelectedTaskReviewNext(SelectedTaskReviewNextQuery {
            project_id,
            task_id,
        }) => ControlQueryDto::SelectedTaskReviewNext {
            query_id: query_id.0.clone(),
            action: "review_next".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
        },
        ServerQueryKind::SelectedTaskReviewOutcomeRoute(SelectedTaskReviewOutcomeRouteQuery {
            project_id,
            task_id,
        }) => ControlQueryDto::SelectedTaskReviewOutcomeRoute {
            query_id: query_id.0.clone(),
            action: "route".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
        },
        ServerQueryKind::SelectedTaskRouteAdmission(SelectedTaskRouteAdmissionQuery {
            project_id,
            task_id,
            expected_revision,
            operator_ref,
        }) => ControlQueryDto::SelectedTaskRouteAdmission {
            query_id: query_id.0.clone(),
            action: "admission".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            operator_ref: operator_ref.clone(),
        },
        ServerQueryKind::SelectedTaskScmHandoff(SelectedTaskScmHandoffQuery {
            project_id,
            task_id,
        }) => ControlQueryDto::SelectedTaskScmHandoff {
            query_id: query_id.0.clone(),
            action: "handoff".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
        },
        ServerQueryKind::SelectedTaskCommandAdmission(SelectedTaskCommandAdmissionQuery {
            project_id,
            task_id,
            family,
            expected_revision,
            reason,
            operator_ref,
        }) => ControlQueryDto::SelectedTaskCommandAdmission {
            query_id: query_id.0.clone(),
            action: "dry_run".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
            family: selected_task_action_family_label(*family).to_owned(),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            reason: reason.clone(),
            operator_ref: operator_ref.clone(),
        },
        ServerQueryKind::SelectedTaskReviewDecisionAdmission(
            SelectedTaskReviewDecisionAdmissionQuery {
                project_id,
                task_id,
                action,
                expected_revision,
                current_revision,
                reason,
                operator_ref,
                reviewed_evidence_refs,
                idempotency_key,
            },
        ) => ControlQueryDto::SelectedTaskReviewDecisionAdmission {
            query_id: query_id.0.clone(),
            action: "dry_run".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
            decision_action: selected_task_review_decision_action_label(*action).to_owned(),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            current_revision: current_revision.as_ref().map(|revision| revision.0.clone()),
            reason: reason.clone(),
            operator_ref: operator_ref.clone(),
            reviewed_evidence_refs: reviewed_evidence_refs.clone(),
            idempotency_key: idempotency_key.clone(),
        },
        ServerQueryKind::SelectedTaskReviewDecisionApply(
            SelectedTaskReviewDecisionApplyQuery {
                project_id,
                task_id,
                action,
                expected_revision,
                current_revision,
                reason,
                operator_ref,
                reviewed_evidence_refs,
                idempotency_key,
            },
        ) => ControlQueryDto::SelectedTaskReviewDecisionApply {
            query_id: query_id.0.clone(),
            action: "apply".to_owned(),
            project_id: project_id.0.clone(),
            task_id: task_id.0.clone(),
            decision_action: selected_task_review_decision_action_label(*action).to_owned(),
            expected_revision: expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            current_revision: current_revision.as_ref().map(|revision| revision.0.clone()),
            reason: reason.clone(),
            operator_ref: operator_ref.clone(),
            reviewed_evidence_refs: reviewed_evidence_refs.clone(),
            idempotency_key: idempotency_key.clone(),
        },
        _ => return Ok(None),
    };

    Ok(Some(dto))
}
