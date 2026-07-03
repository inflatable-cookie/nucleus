use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::ServerStateService;

use super::planning_import_apply_plan::{
    PlanningProjectionImportDryRunApplyOperation, PlanningProjectionImportDryRunApplyOperationKind,
    PlanningProjectionImportDryRunApplyOperationStatus, PlanningProjectionImportDryRunApplyPlan,
};

const STOPPED_APPLY_PLAN_PREFIX: &str = "planning-import-apply-plan:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportApplyPersistenceInput {
    pub plan: PlanningProjectionImportDryRunApplyPlan,
    pub raw_payload_present: bool,
    pub active_planning_mutation_requested: bool,
    pub task_creation_requested: bool,
    pub task_promotion_requested: bool,
    pub projection_write_requested: bool,
    pub agent_scheduling_requested: bool,
    pub provider_execution_requested: bool,
    pub scm_mutation_requested: bool,
    pub forge_mutation_requested: bool,
    pub semantic_merge_requested: bool,
    pub ui_apply_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportStoppedApplyRecord {
    pub stopped_apply_record_id: String,
    pub plan_id: String,
    pub status: PlanningProjectionImportStoppedApplyStatus,
    pub blockers: Vec<PlanningProjectionImportStoppedApplyBlocker>,
    pub operations: Vec<PlanningProjectionImportStoppedApplyOperationRecord>,
    pub planned_operation_count: usize,
    pub skipped_operation_count: usize,
    pub blocked_operation_count: usize,
    pub evidence_ref_count: usize,
    pub duplicate_plan_detected: bool,
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
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningProjectionImportStoppedApplyOperationRecord {
    pub operation_id: String,
    pub readiness_entry_id: String,
    pub admission_record_id: String,
    pub candidate_id: String,
    pub file_ref: String,
    pub record_id: Option<String>,
    pub expected_current_revision: Option<String>,
    pub observed_current_revision: Option<String>,
    pub status: String,
    pub operation_kind: String,
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub blocker_summaries: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportStoppedApplyStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningProjectionImportStoppedApplyBlocker {
    BlockedOperation,
    MissingOperationEvidence,
    MissingOperationRecordId,
    UnsupportedOperationKind,
    RawPayloadPresent,
    PayloadBodyIncluded,
    ActivePlanningMutationRequested,
    TaskCreationRequested,
    TaskPromotionRequested,
    ProjectionWriteRequested,
    AgentSchedulingRequested,
    ProviderExecutionRequested,
    ScmMutationRequested,
    ForgeMutationRequested,
    SemanticMergeRequested,
    UiApplyRequested,
    OperationAuthorityWidened,
}

pub fn persist_planning_projection_import_stopped_apply<B>(
    state: &ServerStateService<B>,
    input: PlanningProjectionImportApplyPersistenceInput,
) -> LocalStoreResult<PlanningProjectionImportStoppedApplyRecord>
where
    B: LocalStoreBackend,
{
    let record_id = stopped_apply_record_id(&input.plan.plan_id);
    if let Some(existing) = state
        .planning()
        .get(&PersistenceRecordId(record_id.clone()))?
    {
        let mut record = decode_stopped_apply_record(&existing.payload.bytes)?;
        record.status = PlanningProjectionImportStoppedApplyStatus::DuplicateNoop;
        record.duplicate_plan_detected = true;
        return Ok(record);
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        PlanningProjectionImportStoppedApplyStatus::Persisted
    } else {
        PlanningProjectionImportStoppedApplyStatus::Blocked
    };
    let record = stopped_apply_record(input.plan, record_id, status, blockers, false);

    if record.status == PlanningProjectionImportStoppedApplyStatus::Persisted {
        write_stopped_apply_record(state, &record)?;
    }

    Ok(record)
}

pub fn read_planning_projection_import_stopped_apply_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<PlanningProjectionImportStoppedApplyRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .planning()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(STOPPED_APPLY_PLAN_PREFIX))
        .map(|record| decode_stopped_apply_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.stopped_apply_record_id
            .cmp(&right.stopped_apply_record_id)
    });
    Ok(records)
}

fn write_stopped_apply_record<B>(
    state: &ServerStateService<B>,
    record: &PlanningProjectionImportStoppedApplyRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.planning().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.stopped_apply_record_id.clone()),
            domain: PersistenceDomain::Planning,
            kind: PersistenceRecordKind::PlanningImportApplyPlan,
            revision_id: RevisionId(format!("rev:{}", record.stopped_apply_record_id)),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: serde_json::to_vec(record).map_err(json_error)?,
            },
        },
        RevisionExpectation::MustNotExist,
    )
}

fn decode_stopped_apply_record(
    bytes: &[u8],
) -> LocalStoreResult<PlanningProjectionImportStoppedApplyRecord> {
    serde_json::from_slice(bytes).map_err(json_error)
}

fn stopped_apply_record(
    plan: PlanningProjectionImportDryRunApplyPlan,
    stopped_apply_record_id: String,
    status: PlanningProjectionImportStoppedApplyStatus,
    blockers: Vec<PlanningProjectionImportStoppedApplyBlocker>,
    duplicate_plan_detected: bool,
) -> PlanningProjectionImportStoppedApplyRecord {
    let operations = plan
        .operations
        .into_iter()
        .map(operation_record)
        .collect::<Vec<_>>();
    let evidence_ref_count = operations
        .iter()
        .map(|operation| operation.evidence_refs.len())
        .sum();

    PlanningProjectionImportStoppedApplyRecord {
        stopped_apply_record_id,
        plan_id: plan.plan_id,
        status,
        blockers,
        planned_operation_count: plan.planned_operation_count,
        skipped_operation_count: plan.skipped_operation_count,
        blocked_operation_count: plan.blocked_operation_count,
        operations,
        evidence_ref_count,
        duplicate_plan_detected,
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
        ui_apply_permitted: false,
    }
}

fn operation_record(
    operation: PlanningProjectionImportDryRunApplyOperation,
) -> PlanningProjectionImportStoppedApplyOperationRecord {
    PlanningProjectionImportStoppedApplyOperationRecord {
        operation_id: operation.operation_id,
        readiness_entry_id: operation.readiness_entry_id,
        admission_record_id: operation.admission_record_id,
        candidate_id: operation.candidate_id,
        file_ref: operation.file_ref,
        record_id: operation.record_id,
        expected_current_revision: operation.expected_current_revision,
        observed_current_revision: operation.observed_current_revision,
        status: operation_status(&operation.status).to_owned(),
        operation_kind: operation_kind(&operation.operation_kind).to_owned(),
        summary: operation.summary,
        evidence_refs: operation.evidence_refs,
        blocker_summaries: operation
            .blockers
            .into_iter()
            .map(|blocker| format!("{blocker:?}"))
            .collect(),
    }
}

fn blockers(
    input: &PlanningProjectionImportApplyPersistenceInput,
) -> Vec<PlanningProjectionImportStoppedApplyBlocker> {
    let mut blockers = Vec::new();
    if input.plan.blocked_operation_count > 0 {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::BlockedOperation);
    }
    if input.plan.payload_body_included {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::PayloadBodyIncluded);
    }
    if input.raw_payload_present || input.plan.raw_payload_retained {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::RawPayloadPresent);
    }
    if input.active_planning_mutation_requested || input.plan.active_planning_mutation_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::ActivePlanningMutationRequested);
    }
    if input.task_creation_requested || input.plan.task_creation_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::TaskCreationRequested);
    }
    if input.task_promotion_requested || input.plan.task_promotion_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::TaskPromotionRequested);
    }
    if input.projection_write_requested || input.plan.projection_write_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::ProjectionWriteRequested);
    }
    if input.agent_scheduling_requested || input.plan.agent_scheduling_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::AgentSchedulingRequested);
    }
    if input.provider_execution_requested || input.plan.provider_execution_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::ProviderExecutionRequested);
    }
    if input.scm_mutation_requested || input.plan.scm_mutation_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::ScmMutationRequested);
    }
    if input.forge_mutation_requested || input.plan.forge_mutation_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::ForgeMutationRequested);
    }
    if input.semantic_merge_requested || input.plan.semantic_merge_performed {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::SemanticMergeRequested);
    }
    if input.ui_apply_requested || input.plan.ui_apply_triggered {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::UiApplyRequested);
    }
    for operation in &input.plan.operations {
        operation_blockers(operation, &mut blockers);
    }
    blockers.sort_by(|left, right| format!("{left:?}").cmp(&format!("{right:?}")));
    blockers.dedup();
    blockers
}

fn operation_blockers(
    operation: &PlanningProjectionImportDryRunApplyOperation,
    blockers: &mut Vec<PlanningProjectionImportStoppedApplyBlocker>,
) {
    if operation.evidence_refs.is_empty() {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::MissingOperationEvidence);
    }
    if operation.status == PlanningProjectionImportDryRunApplyOperationStatus::Planned
        && operation.record_id.is_none()
    {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::MissingOperationRecordId);
    }
    if operation.operation_kind == PlanningProjectionImportDryRunApplyOperationKind::InspectOnly {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::UnsupportedOperationKind);
    }
    if operation.active_planning_mutation_permitted
        || operation.task_creation_permitted
        || operation.task_promotion_permitted
        || operation.projection_write_permitted
        || operation.agent_scheduling_permitted
        || operation.provider_execution_permitted
        || operation.scm_mutation_permitted
        || operation.forge_mutation_permitted
        || operation.ui_apply_permitted
    {
        blockers.push(PlanningProjectionImportStoppedApplyBlocker::OperationAuthorityWidened);
    }
}

fn stopped_apply_record_id(plan_id: &str) -> String {
    format!("{STOPPED_APPLY_PLAN_PREFIX}{plan_id}")
}

fn operation_status(status: &PlanningProjectionImportDryRunApplyOperationStatus) -> &'static str {
    match status {
        PlanningProjectionImportDryRunApplyOperationStatus::Planned => "planned",
        PlanningProjectionImportDryRunApplyOperationStatus::SkippedNoop => "skipped_noop",
        PlanningProjectionImportDryRunApplyOperationStatus::Blocked => "blocked",
    }
}

fn operation_kind(kind: &PlanningProjectionImportDryRunApplyOperationKind) -> &'static str {
    match kind {
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact => {
            "apply_planning_artifact"
        }
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningTaskSeed => {
            "apply_planning_task_seed"
        }
        PlanningProjectionImportDryRunApplyOperationKind::InspectOnly => "inspect_only",
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
