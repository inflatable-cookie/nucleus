//! Provider runtime repair records.
//!
//! These records make uncertain provider runtime states explicit and
//! inspectable. They do not perform repair or automatic recovery.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const PROVIDER_RUNTIME_REPAIR_PREFIX: &str = "provider-runtime-repair:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRuntimeRepairRecordInput {
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub causal_ref: String,
    pub repair_kind: ProviderRuntimeRepairKind,
    pub evidence_refs: Vec<String>,
    pub suggested_next_action: ProviderRuntimeRepairAction,
    pub automatic_recovery_requested: bool,
    pub raw_provider_material_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeRepairKind {
    MissingFrame,
    DecodeFailure,
    ProviderIdentityMismatch,
    UncertainOutcome,
    StaleCursor,
    RetentionPolicyRepair,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeRepairAction {
    InspectEvidence,
    ReplayFromCursor,
    ReconcileOutcome,
    RepairProviderIdentity,
    ApplyRetentionPolicy,
    AskOperator,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderRuntimeRepairRecord {
    pub repair_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub causal_ref: String,
    pub repair_kind: ProviderRuntimeRepairKind,
    pub evidence_refs: Vec<String>,
    pub suggested_next_action: ProviderRuntimeRepairAction,
    pub status: ProviderRuntimeRepairStatus,
    pub automatic_recovery_permitted: bool,
    pub repair_executed: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeRepairStatus {
    RepairRequired,
    Blocked(String),
}

pub fn persist_provider_runtime_repair_record<B>(
    state: &ServerStateService<B>,
    input: ProviderRuntimeRepairRecordInput,
) -> LocalStoreResult<ProviderRuntimeRepairRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;
    let record = repair_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.repair_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.repair_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_provider_runtime_repair_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderRuntimeRepairRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(PROVIDER_RUNTIME_REPAIR_PREFIX))
        .map(|record| {
            serde_json::from_slice::<ProviderRuntimeRepairRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.repair_id.cmp(&right.repair_id));
    Ok(records)
}

fn validate_input(input: &ProviderRuntimeRepairRecordInput) -> LocalStoreResult<()> {
    if input.provider_instance_id.trim().is_empty()
        || input.runtime_session_ref.trim().is_empty()
        || input.causal_ref.trim().is_empty()
        || input.evidence_refs.is_empty()
    {
        return invalid(
            "provider runtime repair requires provider, session, causal, and evidence refs",
        );
    }
    if input
        .evidence_refs
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return invalid("provider runtime repair evidence refs cannot be empty");
    }
    if input.automatic_recovery_requested
        || input.raw_provider_material_requested
        || input.task_mutation_requested
    {
        return invalid(
            "provider runtime repair cannot request automatic recovery, raw material, or task mutation",
        );
    }

    Ok(())
}

fn repair_record_from_input(
    input: ProviderRuntimeRepairRecordInput,
) -> ProviderRuntimeRepairRecord {
    ProviderRuntimeRepairRecord {
        repair_id: format!(
            "{}{}:{}",
            PROVIDER_RUNTIME_REPAIR_PREFIX, input.provider_instance_id, input.causal_ref
        ),
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        causal_ref: input.causal_ref,
        repair_kind: input.repair_kind,
        evidence_refs: unique_sorted(input.evidence_refs),
        suggested_next_action: input.suggested_next_action,
        status: ProviderRuntimeRepairStatus::RepairRequired,
        automatic_recovery_permitted: false,
        repair_executed: false,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerStateService;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn provider_runtime_repair_records_survive_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let persisted = persist_provider_runtime_repair_record(&state, input()).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_provider_runtime_repair_records(&reopened).expect("read");

        assert_eq!(records, vec![persisted]);
        assert_eq!(
            records[0].status,
            ProviderRuntimeRepairStatus::RepairRequired
        );
        assert!(!records[0].automatic_recovery_permitted);
        assert!(!records[0].repair_executed);
    }

    #[test]
    fn provider_runtime_repair_records_cover_required_kinds() {
        let kinds = [
            ProviderRuntimeRepairKind::MissingFrame,
            ProviderRuntimeRepairKind::DecodeFailure,
            ProviderRuntimeRepairKind::ProviderIdentityMismatch,
            ProviderRuntimeRepairKind::UncertainOutcome,
            ProviderRuntimeRepairKind::StaleCursor,
            ProviderRuntimeRepairKind::RetentionPolicyRepair,
        ];

        for kind in kinds {
            let mut input = input();
            input.repair_kind = kind;
            let record = repair_record_from_input(input);
            assert_eq!(record.status, ProviderRuntimeRepairStatus::RepairRequired);
        }
    }

    #[test]
    fn provider_runtime_repair_records_block_automatic_recovery() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.automatic_recovery_requested = true;

        let error = persist_provider_runtime_repair_record(&state, input).expect_err("blocked");

        assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
        assert!(read_provider_runtime_repair_records(&state)
            .expect("read")
            .is_empty());
    }

    fn input() -> ProviderRuntimeRepairRecordInput {
        ProviderRuntimeRepairRecordInput {
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            causal_ref: "decode-outcome:1".to_owned(),
            repair_kind: ProviderRuntimeRepairKind::DecodeFailure,
            evidence_refs: vec!["evidence:repair:1".to_owned()],
            suggested_next_action: ProviderRuntimeRepairAction::InspectEvidence,
            automatic_recovery_requested: false,
            raw_provider_material_requested: false,
            task_mutation_requested: false,
        }
    }
}
