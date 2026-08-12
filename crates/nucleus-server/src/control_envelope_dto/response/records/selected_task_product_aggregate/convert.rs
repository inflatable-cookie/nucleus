//! Selected-task product DTO conversions.
//!
//! Split from the selected_task_product_aggregate god file; behavior
//! unchanged.

use super::labels::{
    action_family_label, action_status_label, command_admission_status_label,
    completion_status_label, rework_status_label, review_next_category_label,
    review_state_label, route_candidate_label, route_status_label, scm_next_category_label,
    scm_state_label, source_label, source_state_label, target_shape_label,
};
use super::super::task_workflow_drilldown::ControlTaskWorkflowNoEffectsDto;
use super::types::{
    ControlSelectedTaskProductAggregateDto, ControlSelectedTaskProductBlockerDto,
    ControlSelectedTaskProductCommandPreviewDto, ControlSelectedTaskProductCommandPreviewsDto,
    ControlSelectedTaskProductCompletionDto, ControlSelectedTaskProductGapDto,
    ControlSelectedTaskProductIdentityDto, ControlSelectedTaskProductReadinessDto,
    ControlSelectedTaskProductReviewDto, ControlSelectedTaskProductReworkDto,
    ControlSelectedTaskProductScmHandoffDto, ControlSelectedTaskProductSourceHealthDto,
    ControlSelectedTaskProductSourceStatusDto, ControlSelectedTaskProductUnavailableActionDto,
    ControlSelectedTaskProductWorkEvidenceDto, ControlSelectedTaskProductWorkflowDto,
};
use crate::{
    SelectedTaskProductAggregate, SelectedTaskProductBlocker,
    SelectedTaskProductCommandPreview, SelectedTaskProductCommandPreviews,
    SelectedTaskProductCompletion, SelectedTaskProductIdentity, SelectedTaskProductReadiness,
    SelectedTaskProductGap, SelectedTaskProductReview, SelectedTaskProductRework, SelectedTaskProductScmHandoff,
    SelectedTaskProductSourceHealth, SelectedTaskProductSourceStatus,
    SelectedTaskProductUnavailableAction, SelectedTaskProductWorkEvidence,
    SelectedTaskProductWorkflow,
};

impl From<&SelectedTaskProductAggregate> for ControlSelectedTaskProductAggregateDto {
    fn from(aggregate: &SelectedTaskProductAggregate) -> Self {
        Self {
            aggregate_id: aggregate.aggregate_id.clone(),
            project_id: aggregate.project_id.0.clone(),
            task_id: aggregate.task_id.0.clone(),
            identity: ControlSelectedTaskProductIdentityDto::from(&aggregate.identity),
            workflow: ControlSelectedTaskProductWorkflowDto::from(&aggregate.workflow),
            readiness: ControlSelectedTaskProductReadinessDto::from(&aggregate.readiness),
            command_previews: ControlSelectedTaskProductCommandPreviewsDto::from(
                &aggregate.command_previews,
            ),
            work_evidence: ControlSelectedTaskProductWorkEvidenceDto::from(
                &aggregate.work_evidence,
            ),
            review: ControlSelectedTaskProductReviewDto::from(&aggregate.review),
            rework: ControlSelectedTaskProductReworkDto::from(&aggregate.rework),
            completion: ControlSelectedTaskProductCompletionDto::from(&aggregate.completion),
            scm_handoff: ControlSelectedTaskProductScmHandoffDto::from(&aggregate.scm_handoff),
            source_health: ControlSelectedTaskProductSourceHealthDto::from(
                &aggregate.source_health,
            ),
            gaps: aggregate
                .gaps
                .iter()
                .map(ControlSelectedTaskProductGapDto::from)
                .collect(),
            no_effects: ControlTaskWorkflowNoEffectsDto::from(&aggregate.no_effects),
        }
    }
}

impl From<&SelectedTaskProductIdentity> for ControlSelectedTaskProductIdentityDto {
    fn from(identity: &SelectedTaskProductIdentity) -> Self {
        Self {
            title: identity.title.clone(),
            activity: identity.activity.clone(),
            assignment: identity.assignment.clone(),
            action_type: identity.action_type.clone(),
            expected_revision: identity
                .expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
        }
    }
}

impl From<&SelectedTaskProductWorkflow> for ControlSelectedTaskProductWorkflowDto {
    fn from(workflow: &SelectedTaskProductWorkflow) -> Self {
        Self {
            primary_next_action: workflow.primary_next_action.clone(),
            reason: workflow.reason.clone(),
            phase: workflow.phase.clone(),
            next_ref: workflow.next_ref.clone(),
            blocked_reason: workflow.blocked_reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductReadiness> for ControlSelectedTaskProductReadinessDto {
    fn from(readiness: &SelectedTaskProductReadiness) -> Self {
        Self {
            blockers: readiness
                .blockers
                .iter()
                .map(ControlSelectedTaskProductBlockerDto::from)
                .collect(),
            unavailable_actions: readiness
                .unavailable_actions
                .iter()
                .map(ControlSelectedTaskProductUnavailableActionDto::from)
                .collect(),
            allowed_action_count: readiness.allowed_action_count,
        }
    }
}

impl From<&SelectedTaskProductBlocker> for ControlSelectedTaskProductBlockerDto {
    fn from(blocker: &SelectedTaskProductBlocker) -> Self {
        Self {
            family: action_family_label(blocker.family).to_owned(),
            reason: blocker.reason.clone(),
            evidence_refs: blocker.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductUnavailableAction>
    for ControlSelectedTaskProductUnavailableActionDto
{
    fn from(action: &SelectedTaskProductUnavailableAction) -> Self {
        Self {
            family: action_family_label(action.family).to_owned(),
            status: action_status_label(action.status).to_owned(),
            reason: action.reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductCommandPreviews> for ControlSelectedTaskProductCommandPreviewsDto {
    fn from(previews: &SelectedTaskProductCommandPreviews) -> Self {
        Self {
            admitted_count: previews.admitted_count,
            refused_count: previews.refused_count,
            previews: previews
                .previews
                .iter()
                .map(ControlSelectedTaskProductCommandPreviewDto::from)
                .collect(),
        }
    }
}

impl From<&SelectedTaskProductCommandPreview> for ControlSelectedTaskProductCommandPreviewDto {
    fn from(preview: &SelectedTaskProductCommandPreview) -> Self {
        Self {
            family: action_family_label(preview.family).to_owned(),
            status: command_admission_status_label(preview.status).to_owned(),
            command_available: preview.command_available,
            refusal_reason: preview.refusal_reason.clone(),
            evidence_refs: preview.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductWorkEvidence> for ControlSelectedTaskProductWorkEvidenceDto {
    fn from(evidence: &SelectedTaskProductWorkEvidence) -> Self {
        Self {
            work_item_refs: evidence.work_item_refs.clone(),
            active_work_item_count: evidence.active_work_item_count,
            completed_work_item_count: evidence.completed_work_item_count,
            evidence_refs: evidence.evidence_refs.clone(),
            timeline_refs: evidence.timeline_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductReview> for ControlSelectedTaskProductReviewDto {
    fn from(review: &SelectedTaskProductReview) -> Self {
        Self {
            state: review.state.map(review_state_label).map(str::to_owned),
            next_category: review
                .next_category
                .map(review_next_category_label)
                .map(str::to_owned),
            route_status: review
                .route_status
                .map(route_status_label)
                .map(str::to_owned),
            primary_route: review
                .primary_route
                .map(route_candidate_label)
                .map(str::to_owned),
            decision_ref: review.decision_ref.clone(),
            decision_available: review.decision_available,
            blocker_reasons: review.blocker_reasons.clone(),
            evidence_refs: review.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductRework> for ControlSelectedTaskProductReworkDto {
    fn from(rework: &SelectedTaskProductRework) -> Self {
        Self {
            status: rework.status.map(rework_status_label).map(str::to_owned),
            summary: rework.summary.clone(),
            refusal_reason: rework.refusal_reason.clone(),
            reviewed_work_item_refs: rework.reviewed_work_item_refs.clone(),
            reviewed_evidence_refs: rework.reviewed_evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductCompletion> for ControlSelectedTaskProductCompletionDto {
    fn from(completion: &SelectedTaskProductCompletion) -> Self {
        Self {
            status: completion
                .status
                .map(completion_status_label)
                .map(str::to_owned),
            command_available: completion.command_available,
            refusal_reason: completion.refusal_reason.clone(),
            evidence_refs: completion.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductScmHandoff> for ControlSelectedTaskProductScmHandoffDto {
    fn from(handoff: &SelectedTaskProductScmHandoff) -> Self {
        Self {
            state: handoff.state.map(scm_state_label).map(str::to_owned),
            next_category: handoff
                .next_category
                .map(scm_next_category_label)
                .map(str::to_owned),
            target_shape: handoff
                .target_shape
                .map(target_shape_label)
                .map(str::to_owned),
            blocker_refs: handoff.blocker_refs.clone(),
            evidence_refs: handoff.evidence_refs.clone(),
            gap_count: handoff.gap_count,
        }
    }
}

impl From<&SelectedTaskProductSourceHealth> for ControlSelectedTaskProductSourceHealthDto {
    fn from(health: &SelectedTaskProductSourceHealth) -> Self {
        Self {
            sources: health
                .sources
                .iter()
                .map(ControlSelectedTaskProductSourceStatusDto::from)
                .collect(),
            missing_count: health.missing_count,
            partial_count: health.partial_count,
        }
    }
}

impl From<&SelectedTaskProductSourceStatus> for ControlSelectedTaskProductSourceStatusDto {
    fn from(status: &SelectedTaskProductSourceStatus) -> Self {
        Self {
            source: source_label(status.source).to_owned(),
            state: source_state_label(status.state).to_owned(),
            reason: status.reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductGap> for ControlSelectedTaskProductGapDto {
    fn from(gap: &SelectedTaskProductGap) -> Self {
        Self {
            source: source_label(gap.source).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}
