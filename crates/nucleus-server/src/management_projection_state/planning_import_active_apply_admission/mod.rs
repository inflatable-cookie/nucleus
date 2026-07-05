use std::collections::BTreeSet;

mod helpers;
mod operation_refs;
mod request_effects;
mod stopped_record;
mod types;

pub use types::{
    PlanningProjectionImportActiveApplyAdmissionBlocker,
    PlanningProjectionImportActiveApplyAdmissionRecord,
    PlanningProjectionImportActiveApplyAdmissionRequest,
    PlanningProjectionImportActiveApplyAdmissionStatus,
    PlanningProjectionImportActiveApplyOperationRef,
    PlanningProjectionImportActiveApplyRevisionExpectationRef,
};

use helpers::{non_empty_option, revision_expectation_map, sorted_unique_refs};
use operation_refs::build_operation_refs;
use request_effects::requested_effect_blockers;
use stopped_record::stopped_apply_record_blockers;

pub fn admit_planning_projection_import_active_apply(
    request: PlanningProjectionImportActiveApplyAdmissionRequest,
) -> PlanningProjectionImportActiveApplyAdmissionRecord {
    let admission_id = request.admission_id.trim().to_owned();
    let duplicate_admission_detected = !admission_id.is_empty()
        && request
            .existing_admission_ids
            .iter()
            .any(|existing| existing == &admission_id);
    let mut blockers = BTreeSet::new();
    requested_effect_blockers(&request, &mut blockers);

    let operator_ref = non_empty_option(request.operator_ref);
    let approval_ref = non_empty_option(request.approval_ref);

    if admission_id.is_empty() {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::MissingAdmissionId);
    }
    if duplicate_admission_detected {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::DuplicateAdmissionId {
                admission_id: admission_id.clone(),
            },
        );
    }
    if operator_ref.is_none() {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperatorRef);
    }
    if approval_ref.is_none() {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::MissingApprovalRef);
    }

    let revision_expectations = revision_expectation_map(request.revision_expectation_refs);
    let mut stopped_apply_record_id = None;
    let mut plan_id = None;
    let mut operation_refs = Vec::new();
    let mut evidence_refs = request.evidence_refs;

    match request.stopped_apply_record {
        Some(record) => {
            stopped_apply_record_id = Some(record.stopped_apply_record_id.clone());
            plan_id = Some(record.plan_id.clone());
            stopped_apply_record_blockers(&record, &mut blockers);
            evidence_refs.extend(record.operations.iter().flat_map(|operation| {
                operation
                    .evidence_refs
                    .iter()
                    .filter(|evidence_ref| !evidence_ref.trim().is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
            }));
            operation_refs =
                build_operation_refs(&record.operations, &revision_expectations, &mut blockers);
        }
        None => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::MissingStoppedApplyRecord,
            );
        }
    }

    evidence_refs = sorted_unique_refs(evidence_refs);
    let blockers = blockers.into_iter().collect::<Vec<_>>();
    let status = if duplicate_admission_detected {
        PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop
    } else if blockers.is_empty() {
        PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped
    } else {
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    };
    let apply_admitted =
        status == PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped;

    PlanningProjectionImportActiveApplyAdmissionRecord {
        admission_id,
        stopped_apply_record_id,
        plan_id,
        operator_ref,
        approval_ref,
        status,
        blockers,
        operation_refs,
        evidence_refs,
        apply_admitted,
        duplicate_admission_detected,
        active_planning_mutation_permitted: false,
        executor_invocation_permitted: false,
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
