use std::collections::{BTreeMap, BTreeSet};

use super::super::planning_import_apply_persistence::PlanningProjectionImportStoppedApplyOperationRecord;
use super::helpers::{non_empty_option, sorted_unique_refs};
use super::types::{
    PlanningProjectionImportActiveApplyAdmissionBlocker,
    PlanningProjectionImportActiveApplyOperationRef,
};

pub(super) fn build_operation_refs(
    operations: &[PlanningProjectionImportStoppedApplyOperationRecord],
    revision_expectations: &BTreeMap<String, String>,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) -> Vec<PlanningProjectionImportActiveApplyOperationRef> {
    operations
        .iter()
        .enumerate()
        .filter_map(|(index, operation)| {
            operation_ref(index, operation, revision_expectations, blockers)
        })
        .collect()
}

fn operation_ref(
    index: usize,
    operation: &PlanningProjectionImportStoppedApplyOperationRecord,
    revision_expectations: &BTreeMap<String, String>,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) -> Option<PlanningProjectionImportActiveApplyOperationRef> {
    let operation_id = operation.operation_id.trim().to_owned();
    if operation_id.is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationId { index },
        );
        return None;
    }
    if operation.status != "planned" {
        return None;
    }
    if operation.file_ref.trim().is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationFileRef {
                operation_id: operation_id.clone(),
            },
        );
    }
    let Some(record_id) = non_empty_option(operation.record_id.clone()) else {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationRecordId {
                operation_id,
            },
        );
        return None;
    };
    if operation.evidence_refs.is_empty() {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationEvidenceRef {
                operation_id: operation_id.clone(),
            },
        );
    }
    match operation.operation_kind.as_str() {
        "apply_planning_artifact" | "apply_planning_task_seed" => {}
        "inspect_only" => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::InspectOnlyOperation {
                    operation_id: operation_id.clone(),
                },
            );
        }
        other => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::UnsupportedOperationKind {
                    operation_id: operation_id.clone(),
                    operation_kind: other.to_owned(),
                },
            );
        }
    }
    revision_expectation_blockers(operation, revision_expectations, blockers);
    summary_blockers(operation, blockers);

    Some(PlanningProjectionImportActiveApplyOperationRef {
        operation_id: operation_id.clone(),
        readiness_entry_id: operation.readiness_entry_id.clone(),
        admission_record_id: operation.admission_record_id.clone(),
        candidate_id: operation.candidate_id.clone(),
        file_ref: operation.file_ref.clone(),
        record_id,
        operation_kind: operation.operation_kind.clone(),
        expected_current_revision: operation.expected_current_revision.clone(),
        observed_current_revision: operation.observed_current_revision.clone(),
        revision_expectation_ref: revision_expectations.get(&operation_id).cloned(),
        evidence_refs: sorted_unique_refs(operation.evidence_refs.clone()),
    })
}

fn revision_expectation_blockers(
    operation: &PlanningProjectionImportStoppedApplyOperationRecord,
    revision_expectations: &BTreeMap<String, String>,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    let Some(expected) = non_empty_option(operation.expected_current_revision.clone()) else {
        return;
    };
    let operation_id = operation.operation_id.trim().to_owned();
    match revision_expectations.get(&operation_id) {
        Some(actual_ref) if actual_ref == &expected => {}
        _ => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRevisionExpectation {
                    operation_id: operation_id.clone(),
                },
            );
        }
    }
    if let Some(observed) = non_empty_option(operation.observed_current_revision.clone()) {
        if observed != expected {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::StaleRevision {
                    operation_id,
                    expected_current_revision: expected,
                    observed_current_revision: observed,
                },
            );
        }
    }
}

fn summary_blockers(
    operation: &PlanningProjectionImportStoppedApplyOperationRecord,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    for summary in &operation.blocker_summaries {
        let lower = summary.to_ascii_lowercase();
        if lower.contains("conflict") {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::ConflictEvidence {
                    operation_id: operation.operation_id.clone(),
                    summary: summary.clone(),
                },
            );
        }
        if lower.contains("repair") {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::RepairRequiredEvidence {
                    operation_id: operation.operation_id.clone(),
                    summary: summary.clone(),
                },
            );
        }
        if lower.contains("missing") {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRefEvidence {
                    operation_id: operation.operation_id.clone(),
                    summary: summary.clone(),
                },
            );
        }
        if lower.contains("unsupported") {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::UnsupportedOperationKind {
                    operation_id: operation.operation_id.clone(),
                    operation_kind: operation.operation_kind.clone(),
                },
            );
        }
    }
}
