use super::types::ManagementProjectionRecordKind;
use super::validation::ManagementProjectionExcludedStateMarker;

/// Authority class for a management projection record or state family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionAuthorityPolicy {
    CommittableShared,
    LocalOnly,
}

/// Classify projection record kinds by default sharing policy.
pub fn projection_record_authority_policy(
    kind: &ManagementProjectionRecordKind,
) -> ManagementProjectionAuthorityPolicy {
    match kind {
        ManagementProjectionRecordKind::Project
        | ManagementProjectionRecordKind::RepoMembership
        | ManagementProjectionRecordKind::Task
        | ManagementProjectionRecordKind::Index
        | ManagementProjectionRecordKind::ArtifactIndex
        | ManagementProjectionRecordKind::PlanningArtifact
        | ManagementProjectionRecordKind::SharedMemory
        | ManagementProjectionRecordKind::ResearchSynthesis => {
            ManagementProjectionAuthorityPolicy::CommittableShared
        }
        ManagementProjectionRecordKind::Custom(_) => ManagementProjectionAuthorityPolicy::LocalOnly,
    }
}

/// Local-only markers that must not enter the shared projection by default.
pub fn default_local_only_projection_markers() -> Vec<ManagementProjectionExcludedStateMarker> {
    vec![
        ManagementProjectionExcludedStateMarker::SecretMaterial,
        ManagementProjectionExcludedStateMarker::ProviderAuthMaterial,
        ManagementProjectionExcludedStateMarker::ProviderNativeTranscript,
        ManagementProjectionExcludedStateMarker::LiveRuntimeEventStream,
        ManagementProjectionExcludedStateMarker::LiveAgentSession,
        ManagementProjectionExcludedStateMarker::TerminalState,
        ManagementProjectionExcludedStateMarker::BrowserState,
        ManagementProjectionExcludedStateMarker::LocalCache,
        ManagementProjectionExcludedStateMarker::LocalIndex,
        ManagementProjectionExcludedStateMarker::LocalClientLayoutState,
        ManagementProjectionExcludedStateMarker::GlobalDisplayWindowSurfaceLayout,
        ManagementProjectionExcludedStateMarker::PerProjectPanelLayout,
        ManagementProjectionExcludedStateMarker::RawValidationOutput,
    ]
}
