use std::collections::BTreeSet;

mod operation;
mod request_effects;
mod types;

pub use types::{
    PlanningProjectionImportActiveApplyExecutorBlocker,
    PlanningProjectionImportActiveApplyExecutorOperationPlan,
    PlanningProjectionImportActiveApplyExecutorPlan,
    PlanningProjectionImportActiveApplyExecutorReceiptPlan,
    PlanningProjectionImportActiveApplyExecutorRequest,
    PlanningProjectionImportActiveApplyExecutorStatus,
};

use operation::build_operation_plans;
use request_effects::requested_effect_blockers;

pub fn plan_planning_projection_import_active_apply_executor(
    request: PlanningProjectionImportActiveApplyExecutorRequest,
) -> PlanningProjectionImportActiveApplyExecutorPlan {
    let executor_plan_id = request.executor_plan_id.trim().to_owned();
    let duplicate_executor_plan_detected = !executor_plan_id.is_empty()
        && request
            .existing_executor_plan_ids
            .iter()
            .any(|existing| existing == &executor_plan_id);
    let mut blockers = BTreeSet::new();
    requested_effect_blockers(&request, &mut blockers);

    if executor_plan_id.is_empty() {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingExecutorPlanId);
    }
    if duplicate_executor_plan_detected {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::DuplicateExecutorPlanId {
                executor_plan_id: executor_plan_id.clone(),
            },
        );
    }

    let mut admission_record_id = None;
    let mut stopped_apply_record_id = None;
    let mut dry_run_apply_plan_id = None;
    let mut operator_ref = None;
    let mut approval_ref = None;
    let mut operation_plans = Vec::new();
    let mut planned_receipts = Vec::new();
    let mut evidence_refs = request.evidence_refs;

    match request.admission_record {
        Some(admission) => {
            admission_record_id = Some(admission.admission_id.clone());
            stopped_apply_record_id = admission.stopped_apply_record_id.clone();
            dry_run_apply_plan_id = admission.plan_id.clone();
            operator_ref = admission.operator_ref.clone();
            approval_ref = admission.approval_ref.clone();
            admission_blockers(&admission, &mut blockers);
            evidence_refs.extend(admission.evidence_refs.clone());
            let (operations, receipts) =
                build_operation_plans(&executor_plan_id, &admission.operation_refs, &mut blockers);
            operation_plans = operations;
            planned_receipts = receipts;
        }
        None => {
            blockers
                .insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingAdmissionRecord);
        }
    }

    evidence_refs = sorted_unique_refs(evidence_refs);
    let blockers = blockers.into_iter().collect::<Vec<_>>();
    let status = if duplicate_executor_plan_detected {
        PlanningProjectionImportActiveApplyExecutorStatus::DuplicateNoop
    } else if blockers.is_empty() {
        PlanningProjectionImportActiveApplyExecutorStatus::PlannedStopped
    } else {
        PlanningProjectionImportActiveApplyExecutorStatus::Blocked
    };
    let executor_planned =
        status == PlanningProjectionImportActiveApplyExecutorStatus::PlannedStopped;

    PlanningProjectionImportActiveApplyExecutorPlan {
        executor_plan_id,
        admission_record_id,
        stopped_apply_record_id,
        dry_run_apply_plan_id,
        operator_ref,
        approval_ref,
        status,
        blockers,
        operation_plans,
        planned_receipts,
        evidence_refs,
        executor_planned,
        duplicate_executor_plan_detected,
        active_planning_mutation_permitted: false,
        final_mutation_receipt_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        semantic_merge_permitted: false,
        accepted_memory_mutation_permitted: false,
        callback_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_permitted: false,
    }
}

fn admission_blockers(
    admission: &super::PlanningProjectionImportActiveApplyAdmissionRecord,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) {
    if admission.status
        != super::PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped
    {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::AdmissionNotAdmitted {
                status: format!("{:?}", admission.status),
            },
        );
    }
    if !admission.apply_admitted {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::ApplyNotAdmitted);
    }
    if admission
        .stopped_apply_record_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingStoppedApplyRecordId,
        );
    }
    if admission.plan_id.as_deref().unwrap_or("").trim().is_empty() {
        blockers
            .insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingDryRunApplyPlanId);
    }
    if admission
        .operator_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperatorRef);
    }
    if admission
        .approval_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingApprovalRef);
    }
    if admission.operation_refs.is_empty() {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationRef);
    }
    if admission.evidence_refs.is_empty() {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingRef);
    }
    if admission.raw_payload_retained {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::RawPayloadPresent);
    }
    if admission.payload_body_included {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::PayloadBodyIncluded);
    }
    for admission_blocker in &admission.blockers {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::AdmissionBlockerPresent {
                blocker: format!("{admission_blocker:?}"),
            },
        );
        classify_admission_blocker(admission_blocker, blockers);
    }
    effect_permission_blockers(admission, blockers);
}

fn classify_admission_blocker(
    blocker: &super::PlanningProjectionImportActiveApplyAdmissionBlocker,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) {
    use super::PlanningProjectionImportActiveApplyAdmissionBlocker as AdmissionBlocker;
    match blocker {
        AdmissionBlocker::StaleRevision { .. } => {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::StaleRevision);
        }
        AdmissionBlocker::ConflictEvidence { .. } => {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::ConflictEvidence);
        }
        AdmissionBlocker::UnsupportedOperationKind { .. }
        | AdmissionBlocker::InspectOnlyOperation { .. } => {
            blockers.insert(
                PlanningProjectionImportActiveApplyExecutorBlocker::UnsupportedOperationKind,
            );
        }
        AdmissionBlocker::RepairRequiredEvidence { .. } => {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::RepairRequired);
        }
        AdmissionBlocker::MissingRefEvidence { .. }
        | AdmissionBlocker::MissingStoppedApplyRecord
        | AdmissionBlocker::MissingOperationRecordId { .. }
        | AdmissionBlocker::MissingOperationFileRef { .. }
        | AdmissionBlocker::MissingOperationEvidenceRef { .. }
        | AdmissionBlocker::MissingRevisionExpectation { .. } => {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::MissingRef);
        }
        AdmissionBlocker::RawPayloadPresent => {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::RawPayloadPresent);
        }
        AdmissionBlocker::PayloadBodyIncluded => {
            blockers
                .insert(PlanningProjectionImportActiveApplyExecutorBlocker::PayloadBodyIncluded);
        }
        AdmissionBlocker::EffectPermissionWidened { .. } => {
            blockers.insert(
                PlanningProjectionImportActiveApplyExecutorBlocker::EffectPermissionWidened {
                    effect: "admission_authority".to_owned(),
                },
            );
        }
        _ => {}
    };
}

fn effect_permission_blockers(
    admission: &super::PlanningProjectionImportActiveApplyAdmissionRecord,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) {
    let effects = [
        (
            admission.active_planning_mutation_permitted,
            "active_planning_mutation",
        ),
        (
            admission.executor_invocation_permitted,
            "executor_invocation",
        ),
        (admission.task_creation_permitted, "task_creation"),
        (admission.task_promotion_permitted, "task_promotion"),
        (admission.projection_write_permitted, "projection_write"),
        (admission.agent_scheduling_permitted, "agent_scheduling"),
        (admission.provider_execution_permitted, "provider_execution"),
        (admission.scm_mutation_permitted, "scm_mutation"),
        (admission.forge_mutation_permitted, "forge_mutation"),
        (admission.semantic_merge_permitted, "semantic_merge"),
        (
            admission.accepted_memory_mutation_permitted,
            "accepted_memory_mutation",
        ),
        (admission.callback_permitted, "callback"),
        (admission.interruption_permitted, "interruption"),
        (admission.recovery_permitted, "recovery"),
        (admission.ui_apply_permitted, "ui_apply"),
    ];
    for (permitted, effect) in effects {
        if permitted {
            blockers.insert(
                PlanningProjectionImportActiveApplyExecutorBlocker::EffectPermissionWidened {
                    effect: effect.to_owned(),
                },
            );
        }
    }
}

fn sorted_unique_refs(refs: Vec<String>) -> Vec<String> {
    refs.into_iter()
        .map(|evidence_ref| evidence_ref.trim().to_owned())
        .filter(|evidence_ref| !evidence_ref.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
