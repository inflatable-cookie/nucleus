use nucleus_core::PersistenceRecordKind;
use nucleus_engine::{ManagementProjectionPayload, ManagementProjectionRecordKind};
use nucleus_local_store::LocalStoreRecord;

use super::super::{
    PlanningProjectionImportActiveApplyExecutorOperationPlan,
    PlanningProjectionImportActiveApplyExecutorPlan,
    PlanningProjectionImportActiveApplyExecutorStatus,
};
use super::types::{
    PlanningProjectionImportMinimumApplyProofBlocker,
    PlanningProjectionImportMinimumApplyProofRequest,
};

pub(super) fn single_operation<'a>(
    plan: &'a PlanningProjectionImportActiveApplyExecutorPlan,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) -> Option<&'a PlanningProjectionImportActiveApplyExecutorOperationPlan> {
    if plan.operation_plans.len() != 1 {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::ExpectedSingleOperation {
                operation_count: plan.operation_plans.len(),
            },
        );
        return None;
    }
    plan.operation_plans.first()
}

pub(super) fn validate_executor_plan(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    let plan = &request.executor_plan;
    validate_plan_refs(request, blockers);
    validate_plan_status(plan, blockers);
    effect_permission_blockers(plan, blockers);
    validate_operation(operation, blockers);
}

pub(super) fn validate_document(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    let Some(operation) = operation else {
        return;
    };
    let envelope = &request.reviewed_document.envelope;
    if envelope.record_id.0 != operation.record_id {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::OperationRecordMismatch {
                expected: operation.record_id.clone(),
                observed: envelope.record_id.0.clone(),
            },
        );
    }
    if envelope.file_ref.0 != operation.file_ref {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::OperationFileMismatch {
                expected: operation.file_ref.clone(),
                observed: envelope.file_ref.0.clone(),
            },
        );
    }
    if envelope.record_kind != ManagementProjectionRecordKind::PlanningArtifact {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::UnsupportedDocumentKind {
                record_kind: format!("{:?}", envelope.record_kind),
            },
        );
    }
    let ManagementProjectionPayload::PlanningArtifact(artifact) =
        &request.reviewed_document.payload
    else {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::UnsupportedDocumentPayload);
        return;
    };
    if artifact.artifact_id != operation.record_id {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::PayloadRecordMismatch {
                expected: operation.record_id.clone(),
                observed: artifact.artifact_id.clone(),
            },
        );
    }
}

pub(super) fn validate_target(
    existing: Option<&LocalStoreRecord>,
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    let Some(operation) = operation else {
        return;
    };
    let Some(existing) = existing else {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingTargetArtifact);
        return;
    };
    if existing.kind != PersistenceRecordKind::PlanningArtifact {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::TargetKindMismatch {
                kind: format!("{:?}", existing.kind),
            },
        );
    }
    if let Some(expected) = &operation.expected_current_revision {
        if existing.revision_id.0 != *expected {
            blockers.push(
                PlanningProjectionImportMinimumApplyProofBlocker::TargetRevisionConflict {
                    expected: expected.clone(),
                    observed: existing.revision_id.0.clone(),
                },
            );
        }
    }
}

fn validate_plan_refs(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    let plan = &request.executor_plan;
    if plan
        .admission_record_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingAdmissionRef);
    }
    if plan
        .stopped_apply_record_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingStoppedApplyRef);
    }
    if plan
        .dry_run_apply_plan_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingDryRunApplyPlanRef);
    }
    if plan.operator_ref.as_deref().unwrap_or("").trim().is_empty() {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingOperatorRef);
    }
    if plan.approval_ref.as_deref().unwrap_or("").trim().is_empty() {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingApprovalRef);
    }
    if request.sanitization_policy_ref.trim().is_empty() {
        blockers
            .push(PlanningProjectionImportMinimumApplyProofBlocker::MissingSanitizationPolicyRef);
    }
    if request.next_revision_id.0.trim().is_empty() {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingNextRevision);
    }
    if request.receipt_id.0.trim().is_empty() {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::MissingReceiptId);
    }
}

fn validate_plan_status(
    plan: &PlanningProjectionImportActiveApplyExecutorPlan,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    if plan.status != PlanningProjectionImportActiveApplyExecutorStatus::PlannedStopped {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::ExecutorNotPlannedStopped {
                status: format!("{:?}", plan.status),
            },
        );
    }
    for plan_blocker in &plan.blockers {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::ExecutorBlockerPresent {
                summary: format!("{plan_blocker:?}"),
            },
        );
    }
}

fn validate_operation(
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    let Some(operation) = operation else {
        return;
    };
    if operation.operation_kind != "apply_planning_artifact" {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::UnsupportedOperationKind {
                operation_kind: operation.operation_kind.clone(),
            },
        );
    }
    match (
        operation.expected_current_revision.as_deref(),
        operation.observed_current_revision.as_deref(),
        operation.revision_expectation_ref.as_deref(),
    ) {
        (Some(expected), Some(observed), Some(revision_ref))
            if !expected.trim().is_empty()
                && !observed.trim().is_empty()
                && !revision_ref.trim().is_empty() =>
        {
            if expected != observed {
                blockers.push(
                    PlanningProjectionImportMinimumApplyProofBlocker::StaleOperationRevision {
                        expected_current_revision: expected.to_owned(),
                        observed_current_revision: observed.to_owned(),
                    },
                );
            }
        }
        _ => blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::MissingOperationRevisionExpectation,
        ),
    }
    if operation.evidence_refs.is_empty() {
        blockers.push(
            PlanningProjectionImportMinimumApplyProofBlocker::MissingEvidenceRef {
                summary: "operation evidence refs are required".to_owned(),
            },
        );
    }
}

fn effect_permission_blockers(
    plan: &PlanningProjectionImportActiveApplyExecutorPlan,
    blockers: &mut Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
) {
    for (permitted, effect) in effect_permissions(plan) {
        if permitted {
            blockers.push(
                PlanningProjectionImportMinimumApplyProofBlocker::EffectPermissionWidened {
                    effect: effect.to_owned(),
                },
            );
        }
    }
    if plan.raw_payload_retained {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::RawPayloadRetained);
    }
    if plan.payload_body_included {
        blockers.push(PlanningProjectionImportMinimumApplyProofBlocker::PayloadBodyRetained);
    }
}

fn effect_permissions(
    plan: &PlanningProjectionImportActiveApplyExecutorPlan,
) -> [(bool, &'static str); 15] {
    [
        (
            plan.active_planning_mutation_permitted,
            "active_planning_mutation",
        ),
        (
            plan.final_mutation_receipt_permitted,
            "final_mutation_receipt",
        ),
        (plan.task_creation_permitted, "task_creation"),
        (plan.task_promotion_permitted, "task_promotion"),
        (plan.projection_write_permitted, "projection_write"),
        (plan.agent_scheduling_permitted, "agent_scheduling"),
        (plan.provider_execution_permitted, "provider_execution"),
        (plan.scm_mutation_permitted, "scm_mutation"),
        (plan.forge_mutation_permitted, "forge_mutation"),
        (plan.semantic_merge_permitted, "semantic_merge"),
        (
            plan.accepted_memory_mutation_permitted,
            "accepted_memory_mutation",
        ),
        (plan.callback_permitted, "callback"),
        (plan.interruption_permitted, "interruption"),
        (plan.recovery_permitted, "recovery"),
        (plan.ui_apply_permitted, "ui_apply"),
    ]
}
