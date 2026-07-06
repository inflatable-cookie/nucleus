//! Serializable control API envelope DTOs.
//!
//! DTOs live at the transport boundary. They are not durable state authority and
//! do not replace server control API types.

mod commands;
mod error;
mod projects;
mod protocol;
mod query;
mod records;
mod request;
mod response;
mod tasks;

pub use commands::ControlCommandDto;
pub use error::ControlApiCodecError;
pub use projects::ControlProjectRecordDto;
pub use query::{ControlQueryDto, ControlQueryScopeDto, ControlStateDomainDto};
pub use records::ControlStateRecordDto;
pub use request::{ControlRequestBodyDto, ControlRequestEnvelopeDto};
pub use response::{
    ControlAcceptedMemoryActiveApplyCountsDto, ControlAcceptedMemoryActiveApplyDiagnosticsDto,
    ControlAcceptedMemoryActiveApplyRecordDto, ControlAcceptedMemoryConfidenceCountDto,
    ControlAcceptedMemoryImportApplyReviewBlockerDto,
    ControlAcceptedMemoryImportApplyReviewCountsDto,
    ControlAcceptedMemoryImportApplyReviewDiagnosticsDto,
    ControlAcceptedMemoryImportApplyReviewReceiptDto, ControlAcceptedMemoryKindCountDto,
    ControlAcceptedMemoryProjectionBlockerDto, ControlAcceptedMemoryProjectionCountsDto,
    ControlAcceptedMemoryProjectionDiagnosticsDto, ControlAcceptedMemoryProjectionEntryDto,
    ControlAcceptedMemoryProjectionImportAdmissionDto,
    ControlAcceptedMemoryProjectionImportApplyBlockerDto,
    ControlAcceptedMemoryProjectionImportApplyCountsDto,
    ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportApplyRecordDto,
    ControlAcceptedMemoryProjectionImportBlockerDto,
    ControlAcceptedMemoryProjectionImportCandidateDto,
    ControlAcceptedMemoryProjectionImportConflictDto,
    ControlAcceptedMemoryProjectionImportCountsDto,
    ControlAcceptedMemoryProjectionImportDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportSummaryDto,
    ControlAcceptedMemoryProjectionWriteBlockerDto, ControlAcceptedMemoryProjectionWriteCountsDto,
    ControlAcceptedMemoryProjectionWriteDiagnosticsDto,
    ControlAcceptedMemoryProjectionWriteEntryDto, ControlAcceptedMemoryRetentionCountDto,
    ControlAcceptedMemoryReviewReadinessCountsDto, ControlAcceptedMemoryReviewReadinessDto,
    ControlAcceptedMemoryReviewReadinessRecordDto,
    ControlAcceptedMemoryReviewReceiptStorageCountsDto,
    ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto,
    ControlAcceptedMemoryReviewReceiptStorageRecordDto, ControlAcceptedMemoryScopeCountDto,
    ControlAcceptedMemorySensitivityCountDto, ControlAcceptedMemorySourceCountsDto,
    ControlAcceptedMemoryStatusCountDto, ControlAcceptedMemorySummaryDto,
    ControlCheckpointRecordDto, ControlCommandEvidenceRecordDto, ControlDiagnosticsResultDto,
    ControlDiagnosticsSnapshotDto, ControlDiffSummaryRecordDto,
    ControlMemoryProposalRetentionCountDto, ControlMemoryProposalReviewDiagnosticEntryDto,
    ControlMemoryProposalReviewDiagnosticsDto, ControlMemoryProposalScopeCountDto,
    ControlMemoryProposalSensitivityCountDto, ControlMemoryProposalSourceCountsDto,
    ControlMemoryProposalStatusCountDto, ControlMemoryProposalSummaryDto,
    ControlPlanningCapturePublicationBucketDto, ControlPlanningCapturePublicationDiagnosticsDto,
    ControlPlanningProjectionFileWriteDiagnosticIssueDto,
    ControlPlanningProjectionFileWriteDiagnosticsDto,
    ControlPlanningProjectionImportActiveApplyBucketDto,
    ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
    ControlPlanningProjectionImportApplyBucketDto,
    ControlPlanningProjectionImportApplyDiagnosticsDto, ControlPlanningProjectionImportBucketDto,
    ControlPlanningProjectionImportDiagnosticsDto, ControlPlanningSessionOutputRefsDto,
    ControlPlanningSessionSourceCountsDto, ControlPlanningSessionStatusCountDto,
    ControlPlanningSessionSummaryDto, ControlPlanningTaskSeedCandidateDto,
    ControlPlanningTaskSeedSourceCountsDto, ControlPlanningTaskSeedStatusCountDto,
    ControlProductWorkflowContextDto, ControlProductWorkflowGapDto, ControlProductWorkflowLaneDto,
    ControlProductWorkflowNextDto, ControlProductWorkflowNoEffectsDto,
    ControlProductWorkflowPlanningContextDto, ControlProductWorkflowProjectDto,
    ControlProductWorkflowReviewDto, ControlProductWorkflowRuntimeDto,
    ControlProductWorkflowScmReadinessDto, ControlProductWorkflowSourceCountsDto,
    ControlProductWorkflowSummaryDto, ControlProjectAuthorityDomainDto,
    ControlProjectAuthorityIssueDto, ControlProjectAuthorityMapDto,
    ControlProviderLiveReadExecutorDiagnosticsDto,
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentEntryDto,
    ControlProviderReadIntentProjectionDto, ControlProviderReadIntentQueryResultDto,
    ControlProviderReadIntentSourceCountsDto, ControlProviderReadinessOverviewDto,
    ControlResearchObservationKindCountDto, ControlResearchRunBriefSourceCountsDto,
    ControlResearchRunBriefStatusCountDto, ControlResearchRunBriefSummaryDto,
    ControlResearchSourceKindCountDto, ControlResearchSynthesisKindCountDto,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ControlResponseStatusDto,
    ControlRuntimeReadinessBlockerDto, ControlRuntimeReadinessDiagnosticDto,
    ControlTaskReadinessCandidateDto, ControlTaskReadinessSourceCountsDto,
    ControlTaskReadinessStatusCountDto, ControlTaskSeedPromotionDiagnosticEntryDto,
    ControlTaskSeedPromotionDiagnosticsDto, ControlTaskTimelineEntryDto,
    ControlTaskWorkflowDrilldownDto, ControlTaskWorkflowGapDto, ControlTaskWorkflowNextDto,
    ControlTaskWorkflowNoEffectsDto, ControlTaskWorkflowReadinessDto, ControlTaskWorkflowReviewDto,
    ControlTaskWorkflowRuntimeDto, ControlTaskWorkflowScmHandoffDto,
    ControlTaskWorkflowSourceCountsDto, ControlTaskWorkflowTaskDto, ControlTaskWorkflowTimelineDto,
    ControlTaskWorkflowWorkItemDto, ControlTaskWorkflowWorkProgressDto,
};
pub use tasks::ControlTaskRecordDto;

#[cfg(test)]
pub(crate) use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
#[cfg(test)]
pub(crate) use crate::state::ServerStateDomain;

#[cfg(test)]
mod tests;
