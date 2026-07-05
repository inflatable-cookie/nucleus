use std::collections::BTreeSet;

use super::types::{
    PlanningProjectionImportActiveApplyExecutorBlocker,
    PlanningProjectionImportActiveApplyExecutorOperationPlan,
    PlanningProjectionImportActiveApplyExecutorReceiptPlan,
};

pub(super) fn build_operation_plans(
    executor_plan_id: &str,
    operation_refs: &[super::super::PlanningProjectionImportActiveApplyOperationRef],
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) -> (
    Vec<PlanningProjectionImportActiveApplyExecutorOperationPlan>,
    Vec<PlanningProjectionImportActiveApplyExecutorReceiptPlan>,
) {
    let mut operation_plans = Vec::new();
    let mut receipt_plans = Vec::new();
    for (index, operation_ref) in operation_refs.iter().enumerate() {
        if let Some(plan) = operation_plan(executor_plan_id, index, operation_ref, blockers) {
            receipt_plans.push(receipt_plan(&plan));
            operation_plans.push(plan);
        }
    }
    (operation_plans, receipt_plans)
}

fn operation_plan(
    executor_plan_id: &str,
    index: usize,
    operation_ref: &super::super::PlanningProjectionImportActiveApplyOperationRef,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) -> Option<PlanningProjectionImportActiveApplyExecutorOperationPlan> {
    let operation_id = operation_ref.operation_id.trim().to_owned();
    if operation_id.is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationId { index },
        );
        return None;
    }
    if operation_ref.record_id.trim().is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationRecordId {
                operation_id,
            },
        );
        return None;
    }
    if operation_ref.file_ref.trim().is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationFileRef {
                operation_id: operation_id.clone(),
            },
        );
    }
    if operation_ref.evidence_refs.is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationEvidenceRef {
                operation_id: operation_id.clone(),
            },
        );
    }
    if operation_ref
        .expected_current_revision
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
        || operation_ref
            .revision_expectation_ref
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::MissingRevisionExpectation {
                operation_id: operation_id.clone(),
            },
        );
    }
    if let (Some(expected), Some(observed)) = (
        operation_ref.expected_current_revision.as_deref(),
        operation_ref.observed_current_revision.as_deref(),
    ) {
        if expected != observed {
            blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::StaleRevision);
        }
    }
    match operation_ref.operation_kind.as_str() {
        "apply_planning_artifact" | "apply_planning_task_seed" => {}
        _ => {
            blockers.insert(
                PlanningProjectionImportActiveApplyExecutorBlocker::UnsupportedOperationKind,
            );
        }
    }

    let operation_plan_id = format!("{executor_plan_id}:operation:{operation_id}");
    Some(PlanningProjectionImportActiveApplyExecutorOperationPlan {
        operation_plan_id,
        source_operation_id: operation_id,
        record_id: operation_ref.record_id.clone(),
        file_ref: operation_ref.file_ref.clone(),
        operation_kind: operation_ref.operation_kind.clone(),
        expected_current_revision: operation_ref.expected_current_revision.clone(),
        observed_current_revision: operation_ref.observed_current_revision.clone(),
        revision_expectation_ref: operation_ref.revision_expectation_ref.clone(),
        evidence_refs: sorted_unique_refs(operation_ref.evidence_refs.clone()),
        active_planning_mutation_permitted: false,
    })
}

fn receipt_plan(
    plan: &PlanningProjectionImportActiveApplyExecutorOperationPlan,
) -> PlanningProjectionImportActiveApplyExecutorReceiptPlan {
    PlanningProjectionImportActiveApplyExecutorReceiptPlan {
        receipt_id: format!("{}:receipt", plan.operation_plan_id),
        operation_plan_id: plan.operation_plan_id.clone(),
        source_operation_id: plan.source_operation_id.clone(),
        status: "stopped_before_mutation".to_owned(),
        evidence_refs: plan.evidence_refs.clone(),
        final_mutation_receipt: false,
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
