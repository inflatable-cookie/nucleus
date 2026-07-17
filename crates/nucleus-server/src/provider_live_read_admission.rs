//! Fixture-backed admission records for provider live reads.

mod blockers;
mod diagnostics;
mod gate;
mod execution;
mod persistence_blockers;
mod persistence_record_builder;
mod persistence_store;
mod preflight_blockers;
mod preflight_record_builder;
mod record_builder;
mod request_receipt_blockers;
mod request_receipt_record_builder;
mod types;

use crate::provider_no_effects::ProviderNoEffects;
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

pub use gate::{ProviderLiveReadAdmissionGate, ProviderLiveReadGateInput};

pub use diagnostics::{
    provider_live_read_persistence_control_dto_from_diagnostics,
    provider_live_read_persistence_diagnostics_from_records,
};
pub use execution::{
    persist_provider_live_read_approved_smoke_evidence_records,
    provider_live_read_approved_smoke_evidence,
    provider_live_read_approved_smoke_evidence_diagnostics, provider_live_read_command_handoff,
    provider_live_read_command_handoff_diagnostics, provider_live_read_command_result_mapping,
    provider_live_read_command_smoke_approval, provider_live_read_command_smoke_diagnostics,
    provider_live_read_command_smoke_request, provider_live_read_command_smoke_target,
    provider_live_read_execution_diagnostics_from_responses, provider_live_read_executor_request,
    provider_live_read_fixture_responses, provider_live_read_gh_repo_view_descriptor,
    provider_live_read_sanitized_repository_metadata_output,
    provider_live_read_server_executor_diagnostics, provider_live_read_server_receipt,
    provider_live_read_smoke_authority_checklist, provider_live_read_smoke_request,
    provider_live_read_smoke_target, provider_live_read_status_check_smoke_checklist,
    provider_live_read_status_check_smoke_diagnostics,
    provider_live_read_status_check_smoke_evidence,
    provider_live_read_status_check_smoke_evidence_diagnostics,
    provider_live_read_status_check_smoke_request, provider_live_read_status_check_smoke_target,
    provider_live_read_stopped_handoff, read_provider_live_read_approved_smoke_evidence_records,
    ProviderLiveReadApprovedSmokeEvidenceBlocker, ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ProviderLiveReadApprovedSmokeEvidenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker,
    ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
    ProviderLiveReadApprovedSmokeEvidencePersistenceSet,
    ProviderLiveReadApprovedSmokeEvidencePersistenceStatus,
    ProviderLiveReadApprovedSmokeEvidenceRecord, ProviderLiveReadApprovedSmokeEvidenceStatus,
    ProviderLiveReadCapabilityRecord, ProviderLiveReadCommandHandoffBlocker,
    ProviderLiveReadCommandHandoffDiagnostics, ProviderLiveReadCommandHandoffInput,
    ProviderLiveReadCommandHandoffRecord, ProviderLiveReadCommandHandoffStatus,
    ProviderLiveReadCommandResultMappingBlocker, ProviderLiveReadCommandResultMappingInput,
    ProviderLiveReadCommandResultMappingRecord, ProviderLiveReadCommandResultMappingStatus,
    ProviderLiveReadCommandSmokeApprovalBlocker, ProviderLiveReadCommandSmokeApprovalInput,
    ProviderLiveReadCommandSmokeApprovalRecord, ProviderLiveReadCommandSmokeApprovalStatus,
    ProviderLiveReadCommandSmokeDiagnostics, ProviderLiveReadCommandSmokeRequestBlocker,
    ProviderLiveReadCommandSmokeRequestInput, ProviderLiveReadCommandSmokeRequestRecord,
    ProviderLiveReadCommandSmokeRequestStatus, ProviderLiveReadCommandSmokeTargetBlocker,
    ProviderLiveReadCommandSmokeTargetInput, ProviderLiveReadCommandSmokeTargetRecord,
    ProviderLiveReadCommandSmokeTargetStatus, ProviderLiveReadExecutionDiagnostics,
    ProviderLiveReadFixtureResponseBlocker, ProviderLiveReadFixtureResponseInput,
    ProviderLiveReadFixtureResponseRecord, ProviderLiveReadFixtureResponseSet,
    ProviderLiveReadFixtureResponseStatus, ProviderLiveReadGhCommandDescriptorBlocker,
    ProviderLiveReadGhCommandDescriptorRecord, ProviderLiveReadGhCommandDescriptorStatus,
    ProviderLiveReadRepositoryMetadataParseBlocker,
    ProviderLiveReadSanitizedRepositoryMetadataRecord,
    ProviderLiveReadSanitizedRepositoryMetadataStatus, ProviderLiveReadServerExecutorDiagnostics,
    ProviderLiveReadServerReceiptBlocker, ProviderLiveReadServerReceiptInput,
    ProviderLiveReadServerReceiptRecord, ProviderLiveReadServerReceiptStatus,
    ProviderLiveReadServerRequestBlocker, ProviderLiveReadServerRequestInput,
    ProviderLiveReadServerRequestRecord, ProviderLiveReadServerRequestStatus,
    ProviderLiveReadSmokeAuthorityChecklistBlocker, ProviderLiveReadSmokeAuthorityChecklistInput,
    ProviderLiveReadSmokeAuthorityChecklistRecord, ProviderLiveReadSmokeAuthorityChecklistStatus,
    ProviderLiveReadSmokeRequestBlocker, ProviderLiveReadSmokeRequestInput,
    ProviderLiveReadSmokeRequestRecord, ProviderLiveReadSmokeRequestStatus,
    ProviderLiveReadSmokeTargetBlocker, ProviderLiveReadSmokeTargetInput,
    ProviderLiveReadSmokeTargetRecord, ProviderLiveReadSmokeTargetStatus,
    ProviderLiveReadStatusCheckSmokeChecklistBlocker,
    ProviderLiveReadStatusCheckSmokeChecklistInput,
    ProviderLiveReadStatusCheckSmokeChecklistRecord,
    ProviderLiveReadStatusCheckSmokeChecklistStatus, ProviderLiveReadStatusCheckSmokeDiagnostics,
    ProviderLiveReadStatusCheckSmokeEvidenceBlocker,
    ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics,
    ProviderLiveReadStatusCheckSmokeEvidenceInput, ProviderLiveReadStatusCheckSmokeEvidenceRecord,
    ProviderLiveReadStatusCheckSmokeEvidenceStatus, ProviderLiveReadStatusCheckSmokeRequestBlocker,
    ProviderLiveReadStatusCheckSmokeRequestInput, ProviderLiveReadStatusCheckSmokeRequestRecord,
    ProviderLiveReadStatusCheckSmokeRequestStatus, ProviderLiveReadStatusCheckSmokeTargetBlocker,
    ProviderLiveReadStatusCheckSmokeTargetInput, ProviderLiveReadStatusCheckSmokeTargetRecord,
    ProviderLiveReadStatusCheckSmokeTargetStatus, ProviderLiveReadStoppedHandoffBlocker,
    ProviderLiveReadStoppedHandoffInput, ProviderLiveReadStoppedHandoffRecord,
    ProviderLiveReadStoppedHandoffSet, ProviderLiveReadStoppedHandoffStatus,
};
pub use types::{
    ProviderLiveReadAdmissionBlocker, ProviderLiveReadAdmissionControlDto,
    ProviderLiveReadAdmissionInput, ProviderLiveReadAdmissionRecord, ProviderLiveReadAdmissionSet,
    ProviderLiveReadAdmissionStatus, ProviderLiveReadPersistenceBlocker,
    ProviderLiveReadPersistenceControlDto, ProviderLiveReadPersistenceDiagnostics,
    ProviderLiveReadPersistenceInput, ProviderLiveReadPersistenceRecord,
    ProviderLiveReadPersistenceSet, ProviderLiveReadPersistenceStatus,
    ProviderLiveReadPreflightBlocker, ProviderLiveReadPreflightInput,
    ProviderLiveReadPreflightRecord, ProviderLiveReadPreflightSet, ProviderLiveReadPreflightStatus,
    ProviderLiveReadRequestReceiptBlocker, ProviderLiveReadRequestReceiptInput,
    ProviderLiveReadRequestReceiptRecord, ProviderLiveReadRequestReceiptSet,
    ProviderLiveReadRequestReceiptStatus,
};

use crate::ServerStateService;
use persistence_blockers::persistence_blockers;
use persistence_record_builder::{persisted_live_read_id, persistence_record};
use persistence_store::{decode_live_read_record, write_live_read_record, LIVE_READ_PREFIX};
use preflight_record_builder::preflight_record;
use record_builder::admission_record;
use request_receipt_record_builder::request_receipt_record;

pub fn provider_live_read_admission(
    input: ProviderLiveReadAdmissionInput,
) -> ProviderLiveReadAdmissionSet {
    let mut records = input
        .provider_context_refs
        .iter()
        .cloned()
        .map(|provider_context_ref| admission_record(&input, provider_context_ref))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    ProviderLiveReadAdmissionSet {
        admission_set_id: "provider-live-read-admission".to_owned(),
        skipped_provider_context_refs: records
            .iter()
            .filter(|record| {
                record.status != ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight
            })
            .map(|record| record.provider_context_ref.clone())
            .collect(),
        fixture_preflight_permitted: records
            .iter()
            .any(|record| record.fixture_preflight_permitted),
        records,
        no_effects: ProviderNoEffects::none(),
    }
}

pub fn provider_live_read_admission_control_dto(
    set: &ProviderLiveReadAdmissionSet,
) -> ProviderLiveReadAdmissionControlDto {
    ProviderLiveReadAdmissionControlDto {
        dto_id: "provider-live-read-admission-control-dto".to_owned(),
        admission_set_id: set.admission_set_id.clone(),
        admission_count: set.records.len(),
        ready_count: status_count(
            set,
            ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight,
        ),
        repair_required_count: status_count(set, ProviderLiveReadAdmissionStatus::RepairRequired),
        unsupported_count: status_count(set, ProviderLiveReadAdmissionStatus::Unsupported),
        blocked_count: status_count(set, ProviderLiveReadAdmissionStatus::Blocked),
        blocker_count: set.records.iter().map(|record| record.blockers.len()).sum(),
        evidence_ref_count: set
            .records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        skipped_provider_context_count: set.skipped_provider_context_refs.len(),
        fixture_preflight_permitted: set.fixture_preflight_permitted,
        no_effects: ProviderNoEffects::none(),
    }
}

pub fn provider_live_read_preflight(
    input: ProviderLiveReadPreflightInput,
) -> ProviderLiveReadPreflightSet {
    let mut preflights = input
        .admissions
        .records
        .iter()
        .cloned()
        .map(|admission| preflight_record(&input, admission))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    ProviderLiveReadPreflightSet {
        preflight_set_id: "provider-live-read-preflight".to_owned(),
        skipped_admission_ids: preflights
            .iter()
            .filter(|preflight| {
                preflight.status != ProviderLiveReadPreflightStatus::ReadyForRequestReceiptPlanning
            })
            .map(|preflight| preflight.admission_id.clone())
            .collect(),
        fixture_request_planning_permitted: preflights
            .iter()
            .any(|preflight| preflight.fixture_request_planning_permitted),
        preflights,
        no_effects: ProviderNoEffects::none(),
    }
}

pub fn provider_live_read_request_receipt(
    input: ProviderLiveReadRequestReceiptInput,
) -> ProviderLiveReadRequestReceiptSet {
    let mut records = input
        .preflights
        .preflights
        .iter()
        .cloned()
        .map(|preflight| request_receipt_record(&input, preflight))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.execution_request_id.cmp(&right.execution_request_id));

    ProviderLiveReadRequestReceiptSet {
        request_receipt_set_id: "provider-live-read-request-receipt".to_owned(),
        skipped_preflight_ids: records
            .iter()
            .filter(|record| {
                record.status != ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded
            })
            .map(|record| record.preflight_id.clone())
            .collect(),
        planned_request_recorded: records.iter().any(|record| record.planned_request_recorded),
        records,
        no_effects: ProviderNoEffects::none(),
    }
}

pub fn persist_provider_live_read_records<B>(
    state: &ServerStateService<B>,
    input: ProviderLiveReadPersistenceInput,
) -> LocalStoreResult<ProviderLiveReadPersistenceSet>
where
    B: LocalStoreBackend,
{
    let mut records = input
        .request_receipts
        .records
        .clone()
        .into_iter()
        .map(|request| {
            let persisted_live_read_id = persisted_live_read_id(&request.execution_request_id);
            let duplicate = input
                .existing_persisted_live_read_ids
                .contains(&persisted_live_read_id);
            let blockers = if duplicate {
                Vec::new()
            } else {
                persistence_blockers(&input, &request)
            };
            persistence_record(&input, request, persisted_live_read_id, duplicate, blockers)
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.persisted_live_read_id
            .cmp(&right.persisted_live_read_id)
    });

    for record in records.iter().filter(|record| {
        record.persistence_status == ProviderLiveReadPersistenceStatus::Persisted
            && !record.duplicate_live_read_detected
    }) {
        write_live_read_record(state, record)?;
    }

    Ok(ProviderLiveReadPersistenceSet {
        persistence_set_id: format!(
            "provider-live-read-persistence:{}",
            input.request_receipts.request_receipt_set_id
        ),
        records,
        no_effects: ProviderNoEffects::none(),
    })
}

pub fn read_provider_live_read_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderLiveReadPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(LIVE_READ_PREFIX))
        .map(|record| decode_live_read_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_live_read_id
            .cmp(&right.persisted_live_read_id)
    });
    Ok(records)
}

fn status_count(
    set: &ProviderLiveReadAdmissionSet,
    status: ProviderLiveReadAdmissionStatus,
) -> usize {
    set.records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
mod tests;
