use super::planning_import_apply_readiness::{
    PlanningProjectionImportApplyReadinessBlocker, PlanningProjectionImportApplyReadinessEntry,
    PlanningProjectionImportApplyReadinessSet, PlanningProjectionImportApplyReadinessStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDryRunApplyPlanRequest {
    pub plan_id: String,
    pub readiness: PlanningProjectionImportApplyReadinessSet,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDryRunApplyPlan {
    pub plan_id: String,
    pub operations: Vec<PlanningProjectionImportDryRunApplyOperation>,
    pub planned_operation_count: usize,
    pub skipped_operation_count: usize,
    pub blocked_operation_count: usize,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub semantic_merge_performed: bool,
    pub raw_payload_retained: bool,
    pub payload_body_included: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDryRunApplyOperation {
    pub operation_id: String,
    pub readiness_entry_id: String,
    pub admission_record_id: String,
    pub candidate_id: String,
    pub file_ref: String,
    pub record_id: Option<String>,
    pub expected_current_revision: Option<String>,
    pub observed_current_revision: Option<String>,
    pub status: PlanningProjectionImportDryRunApplyOperationStatus,
    pub operation_kind: PlanningProjectionImportDryRunApplyOperationKind,
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub blockers: Vec<PlanningProjectionImportApplyReadinessBlocker>,
    pub active_planning_mutation_permitted: bool,
    pub task_creation_permitted: bool,
    pub task_promotion_permitted: bool,
    pub projection_write_permitted: bool,
    pub agent_scheduling_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportDryRunApplyOperationStatus {
    Planned,
    SkippedNoop,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportDryRunApplyOperationKind {
    ApplyPlanningArtifact,
    ApplyPlanningTaskSeed,
    InspectOnly,
}

pub fn plan_planning_projection_import_dry_run_apply(
    request: PlanningProjectionImportDryRunApplyPlanRequest,
) -> PlanningProjectionImportDryRunApplyPlan {
    let mut entries = request.readiness.entries;
    entries.sort_by(|left, right| {
        left.file_ref
            .0
            .cmp(&right.file_ref.0)
            .then_with(|| left.readiness_entry_id.cmp(&right.readiness_entry_id))
    });
    let operations = entries
        .into_iter()
        .map(|entry| dry_run_operation(&request.plan_id, entry))
        .collect::<Vec<_>>();

    PlanningProjectionImportDryRunApplyPlan {
        plan_id: request.plan_id,
        planned_operation_count: count_status(
            &operations,
            PlanningProjectionImportDryRunApplyOperationStatus::Planned,
        ),
        skipped_operation_count: count_status(
            &operations,
            PlanningProjectionImportDryRunApplyOperationStatus::SkippedNoop,
        ),
        blocked_operation_count: count_status(
            &operations,
            PlanningProjectionImportDryRunApplyOperationStatus::Blocked,
        ),
        operations,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        projection_write_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        semantic_merge_performed: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_triggered: false,
    }
}

fn dry_run_operation(
    plan_id: &str,
    entry: PlanningProjectionImportApplyReadinessEntry,
) -> PlanningProjectionImportDryRunApplyOperation {
    let status = operation_status(&entry.status);
    let operation_kind = operation_kind(&entry);
    let summary = operation_summary(&entry, &status, &operation_kind);

    PlanningProjectionImportDryRunApplyOperation {
        operation_id: format!("{plan_id}:{}", entry.readiness_entry_id),
        readiness_entry_id: entry.readiness_entry_id,
        admission_record_id: entry.admission_record_id,
        candidate_id: entry.candidate_id,
        file_ref: entry.file_ref.0,
        record_id: entry.record_id.map(|record_id| record_id.0),
        expected_current_revision: entry.expected_current_revision,
        observed_current_revision: entry.observed_current_revision,
        status,
        operation_kind,
        summary,
        evidence_refs: entry.evidence_refs,
        blockers: entry.blockers,
        active_planning_mutation_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn operation_status(
    status: &PlanningProjectionImportApplyReadinessStatus,
) -> PlanningProjectionImportDryRunApplyOperationStatus {
    match status {
        PlanningProjectionImportApplyReadinessStatus::Ready => {
            PlanningProjectionImportDryRunApplyOperationStatus::Planned
        }
        PlanningProjectionImportApplyReadinessStatus::DuplicateNoop => {
            PlanningProjectionImportDryRunApplyOperationStatus::SkippedNoop
        }
        PlanningProjectionImportApplyReadinessStatus::Blocked
        | PlanningProjectionImportApplyReadinessStatus::Stale
        | PlanningProjectionImportApplyReadinessStatus::Conflict
        | PlanningProjectionImportApplyReadinessStatus::Unsupported
        | PlanningProjectionImportApplyReadinessStatus::RepairRequired => {
            PlanningProjectionImportDryRunApplyOperationStatus::Blocked
        }
    }
}

fn operation_kind(
    entry: &PlanningProjectionImportApplyReadinessEntry,
) -> PlanningProjectionImportDryRunApplyOperationKind {
    if entry.file_ref.0.starts_with("nucleus/planning/task-seeds/") {
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningTaskSeed
    } else if entry.file_ref.0.starts_with("nucleus/planning/") {
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact
    } else {
        PlanningProjectionImportDryRunApplyOperationKind::InspectOnly
    }
}

fn operation_summary(
    entry: &PlanningProjectionImportApplyReadinessEntry,
    status: &PlanningProjectionImportDryRunApplyOperationStatus,
    operation_kind: &PlanningProjectionImportDryRunApplyOperationKind,
) -> String {
    let action = match operation_kind {
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact => {
            "apply planning artifact"
        }
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningTaskSeed => {
            "apply planning task seed"
        }
        PlanningProjectionImportDryRunApplyOperationKind::InspectOnly => "inspect planning import",
    };
    let status = match status {
        PlanningProjectionImportDryRunApplyOperationStatus::Planned => "planned",
        PlanningProjectionImportDryRunApplyOperationStatus::SkippedNoop => "skipped no-op",
        PlanningProjectionImportDryRunApplyOperationStatus::Blocked => "blocked",
    };
    format!("{status}: {action} from {}", entry.file_ref.0)
}

fn count_status(
    operations: &[PlanningProjectionImportDryRunApplyOperation],
    status: PlanningProjectionImportDryRunApplyOperationStatus,
) -> usize {
    operations
        .iter()
        .filter(|operation| operation.status == status)
        .count()
}
