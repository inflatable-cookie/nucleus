//! Persistence records for adapter-neutral change-request chain projections.

use serde::{Deserialize, Serialize};

use crate::{
    AdapterNeutralChangeRequestChainProjection, AdapterNeutralChangeRequestChainStage,
    AdapterNeutralChangeRequestChainStageStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterNeutralChangeRequestChainPersistenceInput {
    pub projections: Vec<AdapterNeutralChangeRequestChainProjection>,
    pub existing_projection_ids: Vec<String>,
    pub raw_material_present: bool,
    pub scm_execution_requested: bool,
    pub forge_execution_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<AdapterNeutralChangeRequestChainPersistenceRecord>,
    pub duplicate_projection_ids: Vec<String>,
    pub blocked_projection_ids: Vec<String>,
    pub scm_execution_permitted: bool,
    pub forge_execution_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainPersistenceRecord {
    pub persisted_projection_id: String,
    pub projection_id: String,
    pub stage_count: usize,
    pub ready_stage_count: usize,
    pub blocked_stage_count: usize,
    pub unsupported_stage_count: usize,
    pub stages: Vec<AdapterNeutralChangeRequestChainStage>,
    pub status: AdapterNeutralChangeRequestChainPersistenceStatus,
    pub blockers: Vec<AdapterNeutralChangeRequestChainPersistenceBlocker>,
    pub duplicate_projection_detected: bool,
    pub scm_execution_permitted: bool,
    pub forge_execution_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestChainPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestChainPersistenceBlocker {
    EmptyProjection,
    RawMaterialPresent,
    ScmExecutionRequested,
    ForgeExecutionRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

pub fn adapter_neutral_change_request_chain_persistence(
    input: AdapterNeutralChangeRequestChainPersistenceInput,
) -> AdapterNeutralChangeRequestChainPersistenceSet {
    let existing_projection_ids = input.existing_projection_ids.clone();
    let flags = PersistenceFlags {
        raw_material_present: input.raw_material_present,
        scm_execution_requested: input.scm_execution_requested,
        forge_execution_requested: input.forge_execution_requested,
        provider_write_requested: input.provider_write_requested,
        task_mutation_requested: input.task_mutation_requested,
        callback_response_requested: input.callback_response_requested,
        interruption_requested: input.interruption_requested,
        recovery_requested: input.recovery_requested,
    };
    let mut records = input
        .projections
        .into_iter()
        .map(|projection| persistence_record(&flags, &existing_projection_ids, projection))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.persisted_projection_id
            .cmp(&right.persisted_projection_id)
    });

    AdapterNeutralChangeRequestChainPersistenceSet {
        persistence_set_id: "adapter-neutral-change-request-chain-persistence".to_owned(),
        duplicate_projection_ids: records
            .iter()
            .filter(|record| record.duplicate_projection_detected)
            .map(|record| record.persisted_projection_id.clone())
            .collect(),
        blocked_projection_ids: records
            .iter()
            .filter(|record| {
                record.status == AdapterNeutralChangeRequestChainPersistenceStatus::Blocked
            })
            .map(|record| record.persisted_projection_id.clone())
            .collect(),
        records,
        scm_execution_permitted: false,
        forge_execution_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}

fn persistence_record(
    flags: &PersistenceFlags,
    existing_projection_ids: &[String],
    projection: AdapterNeutralChangeRequestChainProjection,
) -> AdapterNeutralChangeRequestChainPersistenceRecord {
    let persisted_projection_id = persisted_projection_id(&projection.projection_id);
    let duplicate_projection_detected = existing_projection_ids.contains(&persisted_projection_id);
    let blockers = if duplicate_projection_detected {
        Vec::new()
    } else {
        blockers(flags, &projection)
    };
    let status = if duplicate_projection_detected {
        AdapterNeutralChangeRequestChainPersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        AdapterNeutralChangeRequestChainPersistenceStatus::Persisted
    } else {
        AdapterNeutralChangeRequestChainPersistenceStatus::Blocked
    };

    AdapterNeutralChangeRequestChainPersistenceRecord {
        persisted_projection_id,
        projection_id: projection.projection_id,
        stage_count: projection.stages.len(),
        ready_stage_count: stage_status_count(
            &projection.stages,
            AdapterNeutralChangeRequestChainStageStatus::Ready,
        ),
        blocked_stage_count: stage_status_count(
            &projection.stages,
            AdapterNeutralChangeRequestChainStageStatus::Blocked,
        ),
        unsupported_stage_count: stage_status_count(
            &projection.stages,
            AdapterNeutralChangeRequestChainStageStatus::Unsupported,
        ),
        stages: projection.stages,
        status,
        blockers,
        duplicate_projection_detected,
        scm_execution_permitted: false,
        forge_execution_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}

fn blockers(
    flags: &PersistenceFlags,
    projection: &AdapterNeutralChangeRequestChainProjection,
) -> Vec<AdapterNeutralChangeRequestChainPersistenceBlocker> {
    let mut blockers = Vec::new();
    if projection.stages.is_empty() {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::EmptyProjection);
    }
    if flags.raw_material_present || projection.raw_output_retained {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::RawMaterialPresent);
    }
    if flags.scm_execution_requested {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::ScmExecutionRequested);
    }
    if flags.forge_execution_requested {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::ForgeExecutionRequested);
    }
    if flags.provider_write_requested {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::ProviderWriteRequested);
    }
    if flags.task_mutation_requested || projection.task_mutation_executed {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::TaskMutationRequested);
    }
    if flags.callback_response_requested {
        blockers
            .push(AdapterNeutralChangeRequestChainPersistenceBlocker::CallbackResponseRequested);
    }
    if flags.interruption_requested {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::InterruptionRequested);
    }
    if flags.recovery_requested {
        blockers.push(AdapterNeutralChangeRequestChainPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn stage_status_count(
    stages: &[AdapterNeutralChangeRequestChainStage],
    status: AdapterNeutralChangeRequestChainStageStatus,
) -> usize {
    stages.iter().filter(|stage| stage.status == status).count()
}

fn persisted_projection_id(projection_id: &str) -> String {
    format!("adapter-neutral-change-request-chain-persistence:{projection_id}")
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PersistenceFlags {
    raw_material_present: bool,
    scm_execution_requested: bool,
    forge_execution_requested: bool,
    provider_write_requested: bool,
    task_mutation_requested: bool,
    callback_response_requested: bool,
    interruption_requested: bool,
    recovery_requested: bool,
}

#[cfg(test)]
#[path = "provider_adapter_neutral_change_request_chain_persistence/tests.rs"]
mod tests;
