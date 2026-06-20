//! Sanitized provider session binding persistence.
//!
//! These records bind a configured provider instance to a runtime session and
//! provider thread/session references. They do not retain credentials, raw
//! provider payloads, live handles, transport writes, or task mutation
//! authority.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const PROVIDER_SESSION_BINDING_PREFIX: &str = "provider-session-binding:";

/// Stable id for one provider session binding record.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Deserialize, Serialize)]
pub struct ProviderSessionBindingId(pub String);

/// Input for a sanitized provider session binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderSessionBindingInput {
    pub binding_id: ProviderSessionBindingId,
    pub provider_instance_id: String,
    pub provider_service_id: String,
    pub runtime_session_ref: String,
    pub provider_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub lifecycle_state: ProviderSessionLifecycleState,
    pub evidence_refs: Vec<String>,
    pub repair_state: ProviderSessionRepairState,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub secret_material_requested: bool,
    pub live_handle_requested: bool,
    pub task_mutation_requested: bool,
}

/// Persisted sanitized binding between a provider instance and runtime session.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ProviderSessionBindingRecord {
    pub binding_id: ProviderSessionBindingId,
    pub provider_instance_id: String,
    pub provider_service_id: String,
    pub runtime_session_ref: String,
    pub provider_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub lifecycle_state: ProviderSessionLifecycleState,
    pub evidence_refs: Vec<String>,
    pub repair_state: ProviderSessionRepairState,
    pub provider_write_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub secret_material_retained: bool,
    pub live_handle_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Coarse provider session lifecycle known to the server.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum ProviderSessionLifecycleState {
    Starting,
    Active,
    WaitingForProvider,
    WaitingForCallback,
    Interrupted,
    Recovering,
    Completed,
    Failed(String),
    Unknown,
}

/// Repair posture for a provider session binding.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum ProviderSessionRepairState {
    Healthy,
    NeedsIdentityRepair { reason: String },
    NeedsRuntimeRecovery { evidence_ref: String },
    ProviderUnavailable { evidence_ref: String },
    Unknown,
}

/// Persistence refs produced for one provider session binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderSessionBindingPersistenceRecord {
    pub binding_id: ProviderSessionBindingId,
    pub persisted_record_id: PersistenceRecordId,
    pub provider_write_executed: bool,
    pub raw_provider_material_persisted: bool,
    pub secret_material_persisted: bool,
    pub live_handle_persisted: bool,
    pub task_mutation_permitted: bool,
}

/// Build a sanitized provider session binding record.
pub fn provider_session_binding(
    input: ProviderSessionBindingInput,
) -> LocalStoreResult<ProviderSessionBindingRecord> {
    validate_identity(&input)?;
    validate_forbidden_requests(&input)?;

    Ok(ProviderSessionBindingRecord {
        binding_id: input.binding_id,
        provider_instance_id: input.provider_instance_id,
        provider_service_id: input.provider_service_id,
        runtime_session_ref: input.runtime_session_ref,
        provider_session_ref: input.provider_session_ref,
        provider_thread_ref: input.provider_thread_ref,
        lifecycle_state: input.lifecycle_state,
        evidence_refs: input.evidence_refs,
        repair_state: input.repair_state,
        provider_write_permitted: false,
        raw_provider_material_retained: false,
        secret_material_retained: false,
        live_handle_retained: false,
        task_mutation_permitted: false,
    })
}

/// Persist one sanitized provider session binding.
pub fn persist_provider_session_binding<B>(
    state: &ServerStateService<B>,
    record: ProviderSessionBindingRecord,
) -> LocalStoreResult<ProviderSessionBindingPersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_record_for_persistence(&record)?;

    let persisted_record_id = PersistenceRecordId(persistence_id(&record.binding_id));
    state.agent_sessions().put(
        LocalStoreRecord {
            id: persisted_record_id.clone(),
            domain: PersistenceDomain::AgentSessions,
            kind: PersistenceRecordKind::AgentSession,
            revision_id: RevisionId(format!("rev:{}", persisted_record_id.0)),
            payload: json_payload(encode_provider_session_binding(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(ProviderSessionBindingPersistenceRecord {
        binding_id: record.binding_id,
        persisted_record_id,
        provider_write_executed: false,
        raw_provider_material_persisted: false,
        secret_material_persisted: false,
        live_handle_persisted: false,
        task_mutation_permitted: false,
    })
}

/// Read persisted provider session bindings.
pub fn read_provider_session_bindings<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderSessionBindingRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .agent_sessions()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(PROVIDER_SESSION_BINDING_PREFIX))
        .map(|record| decode_provider_session_binding(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.binding_id.0.cmp(&right.binding_id.0));
    Ok(records)
}

fn validate_identity(input: &ProviderSessionBindingInput) -> LocalStoreResult<()> {
    if input.binding_id.0.trim().is_empty() {
        return invalid("provider session binding id is required");
    }
    if input.provider_instance_id.trim().is_empty() {
        return invalid("provider instance id is required");
    }
    if input.provider_service_id.trim().is_empty() {
        return invalid("provider service id is required");
    }
    if input.runtime_session_ref.trim().is_empty() {
        return invalid("runtime session ref is required");
    }
    if input.provider_session_ref.is_none() && input.provider_thread_ref.is_none() {
        return invalid("provider session ref or provider thread ref is required");
    }
    if !input
        .binding_id
        .0
        .contains(input.provider_instance_id.as_str())
    {
        return invalid("provider session binding id must include provider instance id");
    }
    if !input
        .runtime_session_ref
        .contains(input.provider_instance_id.as_str())
    {
        return invalid("runtime session ref must include provider instance id");
    }
    if input.evidence_refs.is_empty() {
        return invalid("provider session binding evidence refs are required");
    }
    if input
        .evidence_refs
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return invalid("provider session binding evidence refs cannot be empty");
    }

    Ok(())
}

fn validate_forbidden_requests(input: &ProviderSessionBindingInput) -> LocalStoreResult<()> {
    if input.provider_write_requested {
        return invalid("provider session binding cannot request provider writes");
    }
    if input.raw_provider_material_requested {
        return invalid("provider session binding cannot request raw provider material");
    }
    if input.secret_material_requested {
        return invalid("provider session binding cannot request secret material");
    }
    if input.live_handle_requested {
        return invalid("provider session binding cannot request live handles");
    }
    if input.task_mutation_requested {
        return invalid("provider session binding cannot request task mutation");
    }

    Ok(())
}

fn validate_record_for_persistence(record: &ProviderSessionBindingRecord) -> LocalStoreResult<()> {
    if record.provider_write_permitted
        || record.raw_provider_material_retained
        || record.secret_material_retained
        || record.live_handle_retained
        || record.task_mutation_permitted
    {
        return invalid("provider session binding contains forbidden authority or material");
    }
    if record.provider_instance_id.trim().is_empty()
        || record.provider_service_id.trim().is_empty()
        || record.runtime_session_ref.trim().is_empty()
        || record.evidence_refs.is_empty()
    {
        return invalid("provider session binding is missing identity evidence");
    }

    Ok(())
}

fn encode_provider_session_binding(
    record: &ProviderSessionBindingRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(record).map_err(json_error)
}

fn decode_provider_session_binding(bytes: &[u8]) -> LocalStoreResult<ProviderSessionBindingRecord> {
    serde_json::from_slice(bytes).map_err(json_error)
}

fn persistence_id(binding_id: &ProviderSessionBindingId) -> String {
    format!("{}{}", PROVIDER_SESSION_BINDING_PREFIX, binding_id.0)
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
    fn provider_session_binding_persistence_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let binding = provider_session_binding(binding_input()).expect("binding");

        let persisted = persist_provider_session_binding(&state, binding.clone())
            .expect("persist provider session binding");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_provider_session_bindings(&reopened).expect("read bindings");

        assert_eq!(records, vec![binding]);
        assert_eq!(
            persisted.persisted_record_id.0,
            "provider-session-binding:provider-session-binding:codex:local-default:1"
        );
        assert!(!persisted.provider_write_executed);
        assert!(!persisted.raw_provider_material_persisted);
        assert!(!persisted.secret_material_persisted);
        assert!(!persisted.live_handle_persisted);
        assert!(!persisted.task_mutation_permitted);
    }

    #[test]
    fn provider_session_binding_blocks_missing_or_mismatched_identity() {
        let mut missing = binding_input();
        missing.provider_thread_ref = None;
        missing.provider_session_ref = None;

        assert!(provider_session_binding(missing).is_err());

        let mut mismatched = binding_input();
        mismatched.runtime_session_ref = "runtime-session:other:1".to_owned();

        assert!(provider_session_binding(mismatched).is_err());
    }

    #[test]
    fn provider_session_binding_rejects_raw_secret_and_live_material() {
        let mut raw = binding_input();
        raw.raw_provider_material_requested = true;
        assert!(provider_session_binding(raw).is_err());

        let mut secret = binding_input();
        secret.secret_material_requested = true;
        assert!(provider_session_binding(secret).is_err());

        let mut handle = binding_input();
        handle.live_handle_requested = true;
        assert!(provider_session_binding(handle).is_err());
    }

    #[test]
    fn provider_session_binding_persistence_rejects_authority_widening() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut binding = provider_session_binding(binding_input()).expect("binding");
        binding.task_mutation_permitted = true;

        let error = persist_provider_session_binding(&state, binding).unwrap_err();

        assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    }

    #[test]
    fn provider_session_binding_persistence_excludes_forbidden_terms() {
        let binding = provider_session_binding(binding_input()).expect("binding");
        let json = String::from_utf8(encode_provider_session_binding(&binding).unwrap()).unwrap();

        for forbidden in [
            "raw_provider_payload",
            "credential-value",
            "secret-value",
            "live-handle-token",
        ] {
            assert!(!json.contains(forbidden));
        }
        assert!(!binding.provider_write_permitted);
        assert!(!binding.task_mutation_permitted);
    }

    fn binding_input() -> ProviderSessionBindingInput {
        ProviderSessionBindingInput {
            binding_id: ProviderSessionBindingId(
                "provider-session-binding:codex:local-default:1".to_owned(),
            ),
            provider_instance_id: "codex:local-default".to_owned(),
            provider_service_id: "provider-service:codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:codex:local-default:1".to_owned(),
            provider_session_ref: Some("provider-session:codex:local-default:1".to_owned()),
            provider_thread_ref: Some("provider-thread:codex:local-default:1".to_owned()),
            lifecycle_state: ProviderSessionLifecycleState::Active,
            evidence_refs: vec!["evidence:provider-session-binding:1".to_owned()],
            repair_state: ProviderSessionRepairState::Healthy,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            secret_material_requested: false,
            live_handle_requested: false,
            task_mutation_requested: false,
        }
    }
}
