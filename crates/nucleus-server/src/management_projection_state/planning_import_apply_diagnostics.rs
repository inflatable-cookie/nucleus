use std::collections::BTreeMap;

use super::planning_import_apply_persistence::{
    PlanningProjectionImportStoppedApplyRecord, PlanningProjectionImportStoppedApplyStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyDiagnostics {
    pub diagnostics_id: String,
    pub stopped_apply_record_count: usize,
    pub persisted_apply_record_count: usize,
    pub duplicate_noop_record_count: usize,
    pub blocked_apply_record_count: usize,
    pub planned_operation_count: usize,
    pub skipped_operation_count: usize,
    pub blocked_operation_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub conflict_count: usize,
    pub stale_count: usize,
    pub duplicate_noop_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub record_status_buckets: Vec<PlanningProjectionImportApplyDiagnosticBucket>,
    pub blocker_buckets: Vec<PlanningProjectionImportApplyDiagnosticBucket>,
    pub active_planning_mutation_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub semantic_merge_permitted: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub private_planning_body_exposed: bool,
    pub provider_payload_exposed: bool,
    pub source_body_exposed: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyDiagnosticBucket {
    pub label: String,
    pub count: usize,
}

pub fn planning_projection_import_apply_diagnostics(
    records: Vec<PlanningProjectionImportStoppedApplyRecord>,
) -> PlanningProjectionImportApplyDiagnostics {
    let mut status_counts = BTreeMap::new();
    let mut blocker_counts = BTreeMap::new();
    let mut diagnostics = PlanningProjectionImportApplyDiagnostics {
        diagnostics_id: "planning-projection-import-apply-diagnostics".to_owned(),
        stopped_apply_record_count: records.len(),
        persisted_apply_record_count: 0,
        duplicate_noop_record_count: 0,
        blocked_apply_record_count: 0,
        planned_operation_count: 0,
        skipped_operation_count: 0,
        blocked_operation_count: 0,
        ready_count: 0,
        blocked_count: 0,
        conflict_count: 0,
        stale_count: 0,
        duplicate_noop_count: 0,
        repair_required_count: 0,
        blocker_count: 0,
        evidence_ref_count: 0,
        record_status_buckets: Vec::new(),
        blocker_buckets: Vec::new(),
        active_planning_mutation_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        semantic_merge_permitted: false,
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
            PlanningProjectionImportStoppedApplyStatus::Persisted => {
                diagnostics.persisted_apply_record_count += 1
            }
            PlanningProjectionImportStoppedApplyStatus::DuplicateNoop => {
                diagnostics.duplicate_noop_record_count += 1
            }
            PlanningProjectionImportStoppedApplyStatus::Blocked => {
                diagnostics.blocked_apply_record_count += 1
            }
        }
        diagnostics.planned_operation_count += record.planned_operation_count;
        diagnostics.skipped_operation_count += record.skipped_operation_count;
        diagnostics.blocked_operation_count += record.blocked_operation_count;
        diagnostics.ready_count += record.planned_operation_count;
        diagnostics.duplicate_noop_count += record.skipped_operation_count;
        diagnostics.blocked_count += record.blocked_operation_count;
        diagnostics.evidence_ref_count += record.evidence_ref_count;
        diagnostics.blocker_count += record.blockers.len();
        for blocker in &record.blockers {
            *blocker_counts.entry(format!("{blocker:?}")).or_insert(0) += 1;
        }
        for operation in &record.operations {
            diagnostics.blocker_count += operation.blocker_summaries.len();
            for blocker in &operation.blocker_summaries {
                *blocker_counts.entry(blocker.clone()).or_insert(0) += 1;
                if blocker.contains("ConflictStaged") {
                    diagnostics.conflict_count += 1;
                }
                if blocker.contains("StaleTargetRevision") {
                    diagnostics.stale_count += 1;
                }
                if blocker.contains("RepairRequired") || blocker.contains("MissingTarget") {
                    diagnostics.repair_required_count += 1;
                }
            }
        }
    }

    diagnostics.record_status_buckets = buckets(status_counts);
    diagnostics.blocker_buckets = buckets(blocker_counts);
    diagnostics
}

fn status_label(status: &PlanningProjectionImportStoppedApplyStatus) -> &'static str {
    match status {
        PlanningProjectionImportStoppedApplyStatus::Persisted => "persisted",
        PlanningProjectionImportStoppedApplyStatus::DuplicateNoop => "duplicate_noop",
        PlanningProjectionImportStoppedApplyStatus::Blocked => "blocked",
    }
}

fn buckets(counts: BTreeMap<String, usize>) -> Vec<PlanningProjectionImportApplyDiagnosticBucket> {
    counts
        .into_iter()
        .map(|(label, count)| PlanningProjectionImportApplyDiagnosticBucket { label, count })
        .collect()
}
