use std::collections::BTreeMap;

use nucleus_core::RevisionId;
use nucleus_engine::{ManagementProjectionFileRef, ManagementProjectionRecordId};

use super::types::{
    PlanningProjectionImportAdmissionRecord, PlanningProjectionImportAdmissionStatus,
    PlanningProjectionImportConflictRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyReadinessInput {
    pub readiness_id: String,
    pub admissions: Vec<PlanningProjectionImportAdmissionRecord>,
    pub conflicts: Vec<PlanningProjectionImportConflictRecord>,
    pub target_revisions: Vec<PlanningProjectionImportApplyTargetRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyTargetRevision {
    pub record_id: ManagementProjectionRecordId,
    pub expected_current_revision: Option<RevisionId>,
    pub observed_current_revision: Option<RevisionId>,
    pub target_exists: bool,
    pub repair_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyReadinessSet {
    pub readiness_id: String,
    pub entries: Vec<PlanningProjectionImportApplyReadinessEntry>,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub duplicate_noop_count: usize,
    pub stale_count: usize,
    pub conflict_count: usize,
    pub unsupported_count: usize,
    pub repair_required_count: usize,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub agent_scheduling_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub semantic_merge_performed: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyReadinessEntry {
    pub readiness_entry_id: String,
    pub admission_record_id: String,
    pub candidate_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub expected_current_revision: Option<String>,
    pub observed_current_revision: Option<String>,
    pub status: PlanningProjectionImportApplyReadinessStatus,
    pub blockers: Vec<PlanningProjectionImportApplyReadinessBlocker>,
    pub conflict_ids: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub apply_permitted: bool,
    pub task_promotion_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportApplyReadinessStatus {
    Ready,
    Blocked,
    DuplicateNoop,
    Stale,
    Conflict,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportApplyReadinessBlocker {
    AdmissionBlocked { summary: String },
    DuplicateNoop { summary: String },
    ConflictStaged { summary: String },
    MissingRecordId { summary: String },
    StaleTargetRevision { summary: String },
    MissingTarget { summary: String },
    RepairRequired { summary: String },
    UnsupportedTarget { summary: String },
}

pub fn assess_planning_projection_import_apply_readiness(
    input: PlanningProjectionImportApplyReadinessInput,
) -> PlanningProjectionImportApplyReadinessSet {
    let conflicts_by_admission = conflicts_by_admission(input.conflicts);
    let target_revisions = target_revisions_by_record(input.target_revisions);
    let mut admissions = input.admissions;
    admissions.sort_by(|left, right| {
        left.file_ref
            .0
            .cmp(&right.file_ref.0)
            .then_with(|| left.admission_record_id.cmp(&right.admission_record_id))
    });

    let entries = admissions
        .into_iter()
        .map(|admission| {
            readiness_entry(
                &input.readiness_id,
                admission,
                &conflicts_by_admission,
                &target_revisions,
            )
        })
        .collect::<Vec<_>>();

    PlanningProjectionImportApplyReadinessSet {
        readiness_id: input.readiness_id,
        ready_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::Ready,
        ),
        blocked_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::Blocked,
        ),
        duplicate_noop_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::DuplicateNoop,
        ),
        stale_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::Stale,
        ),
        conflict_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::Conflict,
        ),
        unsupported_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::Unsupported,
        ),
        repair_required_count: count_status(
            &entries,
            PlanningProjectionImportApplyReadinessStatus::RepairRequired,
        ),
        entries,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        semantic_merge_performed: false,
        raw_payload_retained: false,
        ui_apply_triggered: false,
    }
}

fn readiness_entry(
    readiness_id: &str,
    admission: PlanningProjectionImportAdmissionRecord,
    conflicts_by_admission: &BTreeMap<String, Vec<PlanningProjectionImportConflictRecord>>,
    target_revisions: &[PlanningProjectionImportApplyTargetRevision],
) -> PlanningProjectionImportApplyReadinessEntry {
    let conflicts = conflicts_by_admission
        .get(&admission.admission_record_id)
        .cloned()
        .unwrap_or_default();
    let target_revision = admission.record_id.as_ref().and_then(|record_id| {
        target_revisions
            .iter()
            .find(|target_revision| target_revision.record_id == *record_id)
    });
    let blockers = blockers_for(&admission, &conflicts, target_revision);
    let status = status_for(&admission, &blockers);
    let mut evidence_refs = admission.evidence_refs.clone();
    for conflict in &conflicts {
        evidence_refs.extend(conflict.evidence_refs.iter().cloned());
    }
    evidence_refs.sort();
    evidence_refs.dedup();

    PlanningProjectionImportApplyReadinessEntry {
        readiness_entry_id: format!("{readiness_id}:{}", admission.admission_record_id),
        admission_record_id: admission.admission_record_id,
        candidate_id: admission.candidate_id,
        file_ref: admission.file_ref,
        record_id: admission.record_id,
        expected_current_revision: target_revision
            .and_then(|target_revision| target_revision.expected_current_revision.clone())
            .map(|revision_id| revision_id.0),
        observed_current_revision: target_revision
            .and_then(|target_revision| target_revision.observed_current_revision.clone())
            .map(|revision_id| revision_id.0),
        status,
        blockers,
        conflict_ids: conflicts
            .into_iter()
            .map(|conflict| conflict.conflict_id)
            .collect(),
        evidence_refs,
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn blockers_for(
    admission: &PlanningProjectionImportAdmissionRecord,
    conflicts: &[PlanningProjectionImportConflictRecord],
    target_revision: Option<&PlanningProjectionImportApplyTargetRevision>,
) -> Vec<PlanningProjectionImportApplyReadinessBlocker> {
    let mut blockers = Vec::new();
    if admission.status == PlanningProjectionImportAdmissionStatus::Blocked {
        blockers.push(
            PlanningProjectionImportApplyReadinessBlocker::AdmissionBlocked {
                summary: "admission record is blocked and cannot be prepared for apply".to_owned(),
            },
        );
    }
    if admission.status == PlanningProjectionImportAdmissionStatus::DuplicateNoop {
        blockers.push(
            PlanningProjectionImportApplyReadinessBlocker::DuplicateNoop {
                summary: "admission record is a duplicate no-op".to_owned(),
            },
        );
    }
    if admission.record_id.is_none() {
        blockers.push(
            PlanningProjectionImportApplyReadinessBlocker::MissingRecordId {
                summary: "admission record has no stable planning projection record id".to_owned(),
            },
        );
    }
    if !conflicts.is_empty() {
        blockers.push(
            PlanningProjectionImportApplyReadinessBlocker::ConflictStaged {
                summary: "staged planning import conflict must be resolved before apply".to_owned(),
            },
        );
    }
    if let Some(target_revision) = target_revision {
        if !target_revision.target_exists {
            blockers.push(
                PlanningProjectionImportApplyReadinessBlocker::MissingTarget {
                    summary: "expected local planning projection target is missing".to_owned(),
                },
            );
        }
        if target_revision.repair_required {
            blockers.push(
                PlanningProjectionImportApplyReadinessBlocker::RepairRequired {
                    summary: "target requires explicit repair before apply readiness".to_owned(),
                },
            );
        }
        if target_revision.expected_current_revision != target_revision.observed_current_revision {
            blockers.push(
                PlanningProjectionImportApplyReadinessBlocker::StaleTargetRevision {
                    summary: "target revision changed since import review".to_owned(),
                },
            );
        }
    }
    blockers
}

fn status_for(
    admission: &PlanningProjectionImportAdmissionRecord,
    blockers: &[PlanningProjectionImportApplyReadinessBlocker],
) -> PlanningProjectionImportApplyReadinessStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportApplyReadinessBlocker::RepairRequired { .. }
                | PlanningProjectionImportApplyReadinessBlocker::MissingTarget { .. }
        )
    }) {
        return PlanningProjectionImportApplyReadinessStatus::RepairRequired;
    }
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportApplyReadinessBlocker::StaleTargetRevision { .. }
        )
    }) {
        return PlanningProjectionImportApplyReadinessStatus::Stale;
    }
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportApplyReadinessBlocker::ConflictStaged { .. }
        )
    }) {
        return PlanningProjectionImportApplyReadinessStatus::Conflict;
    }
    if admission.status == PlanningProjectionImportAdmissionStatus::DuplicateNoop {
        return PlanningProjectionImportApplyReadinessStatus::DuplicateNoop;
    }
    if admission.record_id.is_none() {
        return PlanningProjectionImportApplyReadinessStatus::Unsupported;
    }
    if blockers.is_empty() {
        PlanningProjectionImportApplyReadinessStatus::Ready
    } else {
        PlanningProjectionImportApplyReadinessStatus::Blocked
    }
}

fn conflicts_by_admission(
    conflicts: Vec<PlanningProjectionImportConflictRecord>,
) -> BTreeMap<String, Vec<PlanningProjectionImportConflictRecord>> {
    let mut by_admission = BTreeMap::<String, Vec<PlanningProjectionImportConflictRecord>>::new();
    for conflict in conflicts {
        if let Some(admission_record_id) = conflict.admission_record_id.clone() {
            by_admission
                .entry(admission_record_id)
                .or_default()
                .push(conflict);
        }
    }
    for conflicts in by_admission.values_mut() {
        conflicts.sort_by(|left, right| left.conflict_id.cmp(&right.conflict_id));
    }
    by_admission
}

fn target_revisions_by_record(
    target_revisions: Vec<PlanningProjectionImportApplyTargetRevision>,
) -> Vec<PlanningProjectionImportApplyTargetRevision> {
    let mut target_revisions = target_revisions;
    target_revisions.sort_by(|left, right| left.record_id.0.cmp(&right.record_id.0));
    target_revisions
}

fn count_status(
    entries: &[PlanningProjectionImportApplyReadinessEntry],
    status: PlanningProjectionImportApplyReadinessStatus,
) -> usize {
    entries
        .iter()
        .filter(|entry| entry.status == status)
        .count()
}
