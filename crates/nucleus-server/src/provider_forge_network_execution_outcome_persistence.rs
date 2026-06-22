//! Persistence and control for sanitized stopped forge network outcomes.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod record_builder;
mod store;
mod types;

pub use diagnostics::{
    forge_network_execution_outcome_control_dto_from_diagnostics,
    forge_network_execution_outcome_diagnostics_from_persisted_records,
};
pub use types::{
    ForgeNetworkExecutionOutcomeControlDto, ForgeNetworkExecutionOutcomeDiagnosticsRecord,
    ForgeNetworkExecutionOutcomePersistenceBlocker, ForgeNetworkExecutionOutcomePersistenceInput,
    ForgeNetworkExecutionOutcomePersistenceRecord, ForgeNetworkExecutionOutcomePersistenceSet,
    ForgeNetworkExecutionOutcomePersistenceStatus, ForgeNetworkExecutionOutcomeStatus,
};

use crate::ServerStateService;
use record_builder::{outcome_record, persisted_outcome_id};
use store::{decode_outcome_record, write_outcome_record, OUTCOME_PREFIX};
use types::ForgeNetworkExecutionOutcomePersistenceBlocker as Blocker;

pub fn persist_forge_network_execution_outcomes<B>(
    state: &ServerStateService<B>,
    input: ForgeNetworkExecutionOutcomePersistenceInput,
) -> LocalStoreResult<ForgeNetworkExecutionOutcomePersistenceSet>
where
    B: LocalStoreBackend,
{
    let records = input
        .request_receipts
        .request_receipts
        .clone()
        .into_iter()
        .map(|request_receipt| {
            let persisted_outcome_id = persisted_outcome_id(&request_receipt.execution_request_id);
            let duplicate = input.existing_outcome_ids.contains(&persisted_outcome_id);
            let blockers = if duplicate {
                Vec::new()
            } else {
                blockers(&input)
            };
            outcome_record(
                &input,
                request_receipt,
                persisted_outcome_id,
                duplicate,
                blockers,
            )
        })
        .collect::<Vec<_>>();

    for record in records.iter().filter(|record| {
        record.persistence_status == ForgeNetworkExecutionOutcomePersistenceStatus::Persisted
            && !record.duplicate_outcome_detected
    }) {
        write_outcome_record(state, record)?;
    }

    Ok(ForgeNetworkExecutionOutcomePersistenceSet {
        outcome_set_id: format!(
            "forge-network-execution-outcomes:{}",
            input.request_receipts.request_receipt_set_id
        ),
        records,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    })
}

pub fn read_forge_network_execution_outcomes<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ForgeNetworkExecutionOutcomePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(OUTCOME_PREFIX))
        .map(|record| decode_outcome_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persisted_outcome_id.cmp(&right.persisted_outcome_id));
    Ok(records)
}

fn blockers(input: &ForgeNetworkExecutionOutcomePersistenceInput) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(Blocker::MissingEvidenceRef);
    }
    if input.raw_request_body_present {
        blockers.push(Blocker::RawRequestBodyPresent);
    }
    if input.raw_response_body_present {
        blockers.push(Blocker::RawResponseBodyPresent);
    }
    if input.raw_headers_present {
        blockers.push(Blocker::RawHeadersPresent);
    }
    if input.credential_material_present {
        blockers.push(Blocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(Blocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(Blocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(Blocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(Blocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(Blocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(Blocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(Blocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(Blocker::TaskMutationRequested);
    }
    blockers
}

#[cfg(test)]
mod tests;
