use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::super::PlanningProjectionImportActiveApplyExecutorOperationPlan;
use super::types::{
    PlanningProjectionImportMinimumApplyProofBlocker,
    PlanningProjectionImportMinimumApplyProofReceipt,
    PlanningProjectionImportMinimumApplyProofRequest,
    PlanningProjectionImportMinimumApplyProofStatus,
};

pub(super) fn proof_receipt(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    previous_revision_id: Option<String>,
    mut blockers: Vec<PlanningProjectionImportMinimumApplyProofBlocker>,
    status: PlanningProjectionImportMinimumApplyProofStatus,
) -> PlanningProjectionImportMinimumApplyProofReceipt {
    blockers.sort();
    blockers.dedup();

    PlanningProjectionImportMinimumApplyProofReceipt {
        receipt_id: request.receipt_id.0.clone(),
        status,
        blockers,
        target_record_id: operation.map(|operation| operation.record_id.clone()),
        import_file_ref: operation.map(|operation| operation.file_ref.clone()),
        previous_revision_id,
        next_revision_id: Some(request.next_revision_id.0.clone()),
        evidence_refs: evidence_refs(request, operation),
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        accepted_memory_mutation_performed: false,
        semantic_merge_performed: false,
        raw_payload_retained: false,
        ui_apply_triggered: false,
    }
}

pub(super) fn runtime_receipt(
    receipt: &PlanningProjectionImportMinimumApplyProofReceipt,
) -> EngineRuntimeReceiptRecord {
    let record_id = receipt
        .target_record_id
        .clone()
        .unwrap_or_else(|| "unknown".to_owned());
    let status = match receipt.status {
        PlanningProjectionImportMinimumApplyProofStatus::Applied => {
            EngineRuntimeReceiptStatus::Completed
        }
        PlanningProjectionImportMinimumApplyProofStatus::Blocked => {
            EngineRuntimeReceiptStatus::Blocked
        }
    };

    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(receipt.receipt_id.clone()),
        family: EngineRuntimeReceiptEffectFamily::Custom(
            "planning_projection_import_minimum_apply".to_owned(),
        ),
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(format!(
            "planning_artifact_apply:{record_id}"
        ))),
        evidence_refs: runtime_evidence_refs(receipt),
        artifact_refs: Vec::new(),
        summary: Some(format!(
            "{:?} planning projection import apply proof for {record_id}",
            receipt.status
        )),
    }
}

fn evidence_refs(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    operation: Option<&PlanningProjectionImportActiveApplyExecutorOperationPlan>,
) -> Vec<String> {
    let mut evidence_refs = request.executor_plan.evidence_refs.clone();
    evidence_refs.push(request.sanitization_policy_ref.clone());
    if let Some(operation) = operation {
        evidence_refs.extend(operation.evidence_refs.clone());
        if let Some(revision_ref) = &operation.revision_expectation_ref {
            evidence_refs.push(revision_ref.clone());
        }
    }
    if let Some(admission) = &request.executor_plan.admission_record_id {
        evidence_refs.push(admission.clone());
    }
    if let Some(stopped) = &request.executor_plan.stopped_apply_record_id {
        evidence_refs.push(stopped.clone());
    }
    if let Some(plan) = &request.executor_plan.dry_run_apply_plan_id {
        evidence_refs.push(plan.clone());
    }
    if let Some(operator) = &request.executor_plan.operator_ref {
        evidence_refs.push(operator.clone());
    }
    if let Some(approval) = &request.executor_plan.approval_ref {
        evidence_refs.push(approval.clone());
    }
    evidence_refs.sort();
    evidence_refs.dedup();
    evidence_refs
}

fn runtime_evidence_refs(
    receipt: &PlanningProjectionImportMinimumApplyProofReceipt,
) -> Vec<EngineRuntimeReceiptRef> {
    let mut evidence_refs = receipt
        .evidence_refs
        .iter()
        .cloned()
        .map(EngineRuntimeReceiptRef::Custom)
        .collect::<Vec<_>>();
    if let Some(previous) = &receipt.previous_revision_id {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
            "previous_revision:{previous}"
        )));
    }
    if let Some(next) = &receipt.next_revision_id {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
            "next_revision:{next}"
        )));
    }
    evidence_refs
}
