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
    ControlCheckpointRecordDto, ControlCommandEvidenceRecordDto, ControlDiagnosticsResultDto,
    ControlDiagnosticsSnapshotDto, ControlDiffSummaryRecordDto,
    ControlPlanningProjectionFileWriteDiagnosticIssueDto,
    ControlPlanningProjectionFileWriteDiagnosticsDto, ControlPlanningTaskSeedCandidateDto,
    ControlPlanningTaskSeedSourceCountsDto, ControlPlanningTaskSeedStatusCountDto,
    ControlProjectAuthorityDomainDto, ControlProjectAuthorityIssueDto,
    ControlProjectAuthorityMapDto, ControlProviderLiveReadExecutorDiagnosticsDto,
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlProviderReadIntentEntryDto,
    ControlProviderReadIntentProjectionDto, ControlProviderReadIntentQueryResultDto,
    ControlProviderReadIntentSourceCountsDto, ControlProviderReadinessOverviewDto,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ControlResponseStatusDto,
    ControlRuntimeReadinessBlockerDto, ControlRuntimeReadinessDiagnosticDto,
    ControlTaskReadinessCandidateDto, ControlTaskReadinessSourceCountsDto,
    ControlTaskReadinessStatusCountDto, ControlTaskSeedPromotionDiagnosticEntryDto,
    ControlTaskSeedPromotionDiagnosticsDto, ControlTaskTimelineEntryDto,
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
