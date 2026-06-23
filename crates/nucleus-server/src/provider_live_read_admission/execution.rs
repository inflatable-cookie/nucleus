//! Stopped provider live-read execution boundary.

mod approved_smoke_evidence;
mod approved_smoke_evidence_persistence;
mod approved_smoke_evidence_types;
mod command_smoke;
mod command_smoke_types;
mod diagnostics;
mod executor;
mod executor_diagnostics;
mod executor_types;
mod handoff;
mod response;
mod smoke;
mod smoke_types;
mod status_check_smoke;
mod status_check_smoke_evidence;
mod status_check_smoke_evidence_types;
mod status_check_smoke_types;
mod types;

pub use approved_smoke_evidence::{
    provider_live_read_approved_smoke_evidence,
    provider_live_read_approved_smoke_evidence_diagnostics,
};
pub use approved_smoke_evidence_persistence::{
    persist_provider_live_read_approved_smoke_evidence_records,
    read_provider_live_read_approved_smoke_evidence_records,
};
pub use approved_smoke_evidence_types::{
    ProviderLiveReadApprovedSmokeEvidenceBlocker, ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ProviderLiveReadApprovedSmokeEvidenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker,
    ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
    ProviderLiveReadApprovedSmokeEvidencePersistenceSet,
    ProviderLiveReadApprovedSmokeEvidencePersistenceStatus,
    ProviderLiveReadApprovedSmokeEvidenceRecord, ProviderLiveReadApprovedSmokeEvidenceStatus,
};
pub use command_smoke::{
    provider_live_read_command_smoke_approval, provider_live_read_command_smoke_diagnostics,
    provider_live_read_command_smoke_request, provider_live_read_command_smoke_target,
};
pub use command_smoke_types::{
    ProviderLiveReadCommandSmokeApprovalBlocker, ProviderLiveReadCommandSmokeApprovalInput,
    ProviderLiveReadCommandSmokeApprovalRecord, ProviderLiveReadCommandSmokeApprovalStatus,
    ProviderLiveReadCommandSmokeDiagnostics, ProviderLiveReadCommandSmokeRequestBlocker,
    ProviderLiveReadCommandSmokeRequestInput, ProviderLiveReadCommandSmokeRequestRecord,
    ProviderLiveReadCommandSmokeRequestStatus, ProviderLiveReadCommandSmokeTargetBlocker,
    ProviderLiveReadCommandSmokeTargetInput, ProviderLiveReadCommandSmokeTargetRecord,
    ProviderLiveReadCommandSmokeTargetStatus,
};
pub use diagnostics::provider_live_read_execution_diagnostics_from_responses;
pub use executor::{
    provider_live_read_command_handoff, provider_live_read_command_handoff_diagnostics,
    provider_live_read_command_result_mapping, provider_live_read_executor_request,
    provider_live_read_gh_repo_view_descriptor,
    provider_live_read_sanitized_repository_metadata_output, provider_live_read_server_receipt,
};
pub use executor_diagnostics::provider_live_read_server_executor_diagnostics;
pub use executor_types::{
    ProviderLiveReadCommandHandoffBlocker, ProviderLiveReadCommandHandoffDiagnostics,
    ProviderLiveReadCommandHandoffInput, ProviderLiveReadCommandHandoffRecord,
    ProviderLiveReadCommandHandoffStatus, ProviderLiveReadCommandResultMappingBlocker,
    ProviderLiveReadCommandResultMappingInput, ProviderLiveReadCommandResultMappingRecord,
    ProviderLiveReadCommandResultMappingStatus, ProviderLiveReadGhCommandDescriptorBlocker,
    ProviderLiveReadGhCommandDescriptorRecord, ProviderLiveReadGhCommandDescriptorStatus,
    ProviderLiveReadRepositoryMetadataParseBlocker,
    ProviderLiveReadSanitizedRepositoryMetadataRecord,
    ProviderLiveReadSanitizedRepositoryMetadataStatus, ProviderLiveReadServerExecutorDiagnostics,
    ProviderLiveReadServerReceiptBlocker, ProviderLiveReadServerReceiptInput,
    ProviderLiveReadServerReceiptRecord, ProviderLiveReadServerReceiptStatus,
    ProviderLiveReadServerRequestBlocker, ProviderLiveReadServerRequestInput,
    ProviderLiveReadServerRequestRecord, ProviderLiveReadServerRequestStatus,
};
pub use handoff::provider_live_read_stopped_handoff;
pub use response::provider_live_read_fixture_responses;
pub use smoke::{
    provider_live_read_smoke_authority_checklist, provider_live_read_smoke_request,
    provider_live_read_smoke_target,
};
pub use smoke_types::{
    ProviderLiveReadSmokeAuthorityChecklistBlocker, ProviderLiveReadSmokeAuthorityChecklistInput,
    ProviderLiveReadSmokeAuthorityChecklistRecord, ProviderLiveReadSmokeAuthorityChecklistStatus,
    ProviderLiveReadSmokeRequestBlocker, ProviderLiveReadSmokeRequestInput,
    ProviderLiveReadSmokeRequestRecord, ProviderLiveReadSmokeRequestStatus,
    ProviderLiveReadSmokeTargetBlocker, ProviderLiveReadSmokeTargetInput,
    ProviderLiveReadSmokeTargetRecord, ProviderLiveReadSmokeTargetStatus,
};
pub use status_check_smoke::{
    provider_live_read_status_check_smoke_checklist,
    provider_live_read_status_check_smoke_diagnostics,
    provider_live_read_status_check_smoke_request, provider_live_read_status_check_smoke_target,
};
pub use status_check_smoke_evidence::{
    provider_live_read_status_check_smoke_evidence,
    provider_live_read_status_check_smoke_evidence_diagnostics,
};
pub use status_check_smoke_evidence_types::{
    ProviderLiveReadStatusCheckSmokeEvidenceBlocker,
    ProviderLiveReadStatusCheckSmokeEvidenceDiagnostics,
    ProviderLiveReadStatusCheckSmokeEvidenceInput, ProviderLiveReadStatusCheckSmokeEvidenceRecord,
    ProviderLiveReadStatusCheckSmokeEvidenceStatus,
};
pub use status_check_smoke_types::{
    ProviderLiveReadStatusCheckSmokeChecklistBlocker,
    ProviderLiveReadStatusCheckSmokeChecklistInput,
    ProviderLiveReadStatusCheckSmokeChecklistRecord,
    ProviderLiveReadStatusCheckSmokeChecklistStatus, ProviderLiveReadStatusCheckSmokeDiagnostics,
    ProviderLiveReadStatusCheckSmokeRequestBlocker, ProviderLiveReadStatusCheckSmokeRequestInput,
    ProviderLiveReadStatusCheckSmokeRequestRecord, ProviderLiveReadStatusCheckSmokeRequestStatus,
    ProviderLiveReadStatusCheckSmokeTargetBlocker, ProviderLiveReadStatusCheckSmokeTargetInput,
    ProviderLiveReadStatusCheckSmokeTargetRecord, ProviderLiveReadStatusCheckSmokeTargetStatus,
};
pub use types::{
    ProviderLiveReadCapabilityRecord, ProviderLiveReadExecutionDiagnostics,
    ProviderLiveReadFixtureResponseBlocker, ProviderLiveReadFixtureResponseInput,
    ProviderLiveReadFixtureResponseRecord, ProviderLiveReadFixtureResponseSet,
    ProviderLiveReadFixtureResponseStatus, ProviderLiveReadStoppedHandoffBlocker,
    ProviderLiveReadStoppedHandoffInput, ProviderLiveReadStoppedHandoffRecord,
    ProviderLiveReadStoppedHandoffSet, ProviderLiveReadStoppedHandoffStatus,
};

#[cfg(test)]
mod approved_smoke_evidence_tests;

#[cfg(test)]
mod approved_smoke_evidence_persistence_tests;

#[cfg(test)]
mod executor_tests;

#[cfg(test)]
mod command_smoke_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod smoke_tests;

#[cfg(test)]
mod status_check_smoke_tests;

#[cfg(test)]
mod status_check_smoke_evidence_tests;
