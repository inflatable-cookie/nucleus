use std::collections::BTreeMap;

use super::planning_import_active_apply_admission::{
    PlanningProjectionImportActiveApplyAdmissionBlocker,
    PlanningProjectionImportActiveApplyAdmissionRecord,
    PlanningProjectionImportActiveApplyAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportActiveApplyDiagnostics {
    pub diagnostics_id: String,
    pub admission_record_count: usize,
    pub admitted_record_count: usize,
    pub duplicate_noop_record_count: usize,
    pub blocked_record_count: usize,
    pub operation_ref_count: usize,
    pub evidence_ref_count: usize,
    pub blocker_count: usize,
    pub stale_count: usize,
    pub conflict_count: usize,
    pub unsupported_count: usize,
    pub repair_required_count: usize,
    pub missing_ref_count: usize,
    pub record_status_buckets: Vec<PlanningProjectionImportActiveApplyDiagnosticBucket>,
    pub blocker_buckets: Vec<PlanningProjectionImportActiveApplyDiagnosticBucket>,
    pub active_planning_mutation_permitted: bool,
    pub executor_invocation_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub semantic_merge_permitted: bool,
    pub accepted_memory_mutation_permitted: bool,
    pub callback_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub private_planning_body_exposed: bool,
    pub provider_payload_exposed: bool,
    pub source_body_exposed: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportActiveApplyDiagnosticBucket {
    pub label: String,
    pub count: usize,
}

pub fn planning_projection_import_active_apply_diagnostics(
    records: Vec<PlanningProjectionImportActiveApplyAdmissionRecord>,
) -> PlanningProjectionImportActiveApplyDiagnostics {
    let mut status_counts = BTreeMap::new();
    let mut blocker_counts = BTreeMap::new();
    let mut diagnostics = PlanningProjectionImportActiveApplyDiagnostics {
        diagnostics_id: "planning-projection-import-active-apply-diagnostics".to_owned(),
        admission_record_count: records.len(),
        admitted_record_count: 0,
        duplicate_noop_record_count: 0,
        blocked_record_count: 0,
        operation_ref_count: 0,
        evidence_ref_count: 0,
        blocker_count: 0,
        stale_count: 0,
        conflict_count: 0,
        unsupported_count: 0,
        repair_required_count: 0,
        missing_ref_count: 0,
        record_status_buckets: Vec::new(),
        blocker_buckets: Vec::new(),
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
        private_planning_body_exposed: false,
        provider_payload_exposed: false,
        source_body_exposed: false,
        ui_apply_permitted: false,
    };

    for record in &records {
        *status_counts
            .entry(status_label(&record.status).to_owned())
            .or_insert(0) += 1;
        match record.status {
            PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped => {
                diagnostics.admitted_record_count += 1
            }
            PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop => {
                diagnostics.duplicate_noop_record_count += 1
            }
            PlanningProjectionImportActiveApplyAdmissionStatus::Blocked => {
                diagnostics.blocked_record_count += 1
            }
        }
        diagnostics.operation_ref_count += record.operation_refs.len();
        diagnostics.evidence_ref_count += record.evidence_refs.len()
            + record
                .operation_refs
                .iter()
                .map(|operation| operation.evidence_refs.len())
                .sum::<usize>();
        diagnostics.blocker_count += record.blockers.len();
        merge_no_effect_flags(record, &mut diagnostics);
        for blocker in &record.blockers {
            *blocker_counts.entry(blocker_label(blocker)).or_insert(0) += 1;
            classify_blocker(blocker, &mut diagnostics);
        }
    }

    diagnostics.record_status_buckets = buckets(status_counts);
    diagnostics.blocker_buckets = buckets(blocker_counts);
    diagnostics
}

fn merge_no_effect_flags(
    record: &PlanningProjectionImportActiveApplyAdmissionRecord,
    diagnostics: &mut PlanningProjectionImportActiveApplyDiagnostics,
) {
    diagnostics.active_planning_mutation_permitted |= record.active_planning_mutation_permitted;
    diagnostics.executor_invocation_permitted |= record.executor_invocation_permitted;
    diagnostics.task_creation_permitted |= record.task_creation_permitted;
    diagnostics.task_promotion_permitted |= record.task_promotion_permitted;
    diagnostics.projection_write_permitted |= record.projection_write_permitted;
    diagnostics.agent_scheduling_permitted |= record.agent_scheduling_permitted;
    diagnostics.provider_execution_permitted |= record.provider_execution_permitted;
    diagnostics.scm_mutation_permitted |= record.scm_mutation_permitted;
    diagnostics.forge_mutation_permitted |= record.forge_mutation_permitted;
    diagnostics.semantic_merge_permitted |= record.semantic_merge_permitted;
    diagnostics.accepted_memory_mutation_permitted |= record.accepted_memory_mutation_permitted;
    diagnostics.callback_permitted |= record.callback_permitted;
    diagnostics.interruption_permitted |= record.interruption_permitted;
    diagnostics.recovery_permitted |= record.recovery_permitted;
    diagnostics.raw_payload_retained |= record.raw_payload_retained;
    diagnostics.payload_body_included |= record.payload_body_included;
    diagnostics.ui_apply_permitted |= record.ui_apply_permitted;
}

fn classify_blocker(
    blocker: &PlanningProjectionImportActiveApplyAdmissionBlocker,
    diagnostics: &mut PlanningProjectionImportActiveApplyDiagnostics,
) {
    match blocker {
        PlanningProjectionImportActiveApplyAdmissionBlocker::StaleRevision { .. } => {
            diagnostics.stale_count += 1
        }
        PlanningProjectionImportActiveApplyAdmissionBlocker::ConflictEvidence { .. } => {
            diagnostics.conflict_count += 1
        }
        PlanningProjectionImportActiveApplyAdmissionBlocker::UnsupportedOperationKind {
            ..
        }
        | PlanningProjectionImportActiveApplyAdmissionBlocker::InspectOnlyOperation { .. } => {
            diagnostics.unsupported_count += 1
        }
        PlanningProjectionImportActiveApplyAdmissionBlocker::RepairRequiredEvidence { .. } => {
            diagnostics.repair_required_count += 1
        }
        PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRefEvidence { .. }
        | PlanningProjectionImportActiveApplyAdmissionBlocker::MissingStoppedApplyRecord
        | PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationRecordId {
            ..
        }
        | PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationFileRef { .. }
        | PlanningProjectionImportActiveApplyAdmissionBlocker::MissingOperationEvidenceRef {
            ..
        }
        | PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRevisionExpectation {
            ..
        } => diagnostics.missing_ref_count += 1,
        _ => {}
    }
}

fn status_label(status: &PlanningProjectionImportActiveApplyAdmissionStatus) -> &'static str {
    match status {
        PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped => "admitted_stopped",
        PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop => "duplicate_noop",
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked => "blocked",
    }
}

fn blocker_label(blocker: &PlanningProjectionImportActiveApplyAdmissionBlocker) -> String {
    format!("{blocker:?}")
}

fn buckets(
    counts: BTreeMap<String, usize>,
) -> Vec<PlanningProjectionImportActiveApplyDiagnosticBucket> {
    counts
        .into_iter()
        .map(|(label, count)| PlanningProjectionImportActiveApplyDiagnosticBucket { label, count })
        .collect()
}
