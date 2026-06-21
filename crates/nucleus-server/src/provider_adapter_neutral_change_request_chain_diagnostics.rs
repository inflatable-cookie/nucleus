//! Diagnostics for adapter-neutral change-request chain projections.

use serde::{Deserialize, Serialize};

use crate::{
    AdapterNeutralChangeRequestChainProjection, AdapterNeutralChangeRequestChainStageStatus,
    AdapterNeutralChangeRequestProviderStageRef, AdapterNeutralChangeRequestStageKind,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainDiagnosticsRecord {
    pub diagnostics_id: String,
    pub stage_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub unsupported_count: usize,
    pub isolated_work_area_count: usize,
    pub local_revision_count: usize,
    pub remote_share_count: usize,
    pub review_request_count: usize,
    pub unsupported_stage_count: usize,
    pub git_like_provider_ref_count: usize,
    pub convergence_like_provider_ref_count: usize,
    pub unsupported_provider_ref_count: usize,
    pub blocker_count: usize,
    pub branch_or_snapshot_authority_granted: bool,
    pub local_revision_authority_granted: bool,
    pub remote_share_authority_granted: bool,
    pub review_request_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

pub fn adapter_neutral_change_request_chain_diagnostics(
    projection: AdapterNeutralChangeRequestChainProjection,
) -> AdapterNeutralChangeRequestChainDiagnosticsRecord {
    AdapterNeutralChangeRequestChainDiagnosticsRecord {
        diagnostics_id: "adapter-neutral-change-request-chain-diagnostics".to_owned(),
        stage_count: projection.stages.len(),
        ready_count: status_count(
            &projection,
            AdapterNeutralChangeRequestChainStageStatus::Ready,
        ),
        blocked_count: status_count(
            &projection,
            AdapterNeutralChangeRequestChainStageStatus::Blocked,
        ),
        unsupported_count: status_count(
            &projection,
            AdapterNeutralChangeRequestChainStageStatus::Unsupported,
        ),
        isolated_work_area_count: stage_kind_count(
            &projection,
            AdapterNeutralChangeRequestStageKind::IsolatedWorkArea,
        ),
        local_revision_count: stage_kind_count(
            &projection,
            AdapterNeutralChangeRequestStageKind::LocalRevision,
        ),
        remote_share_count: stage_kind_count(
            &projection,
            AdapterNeutralChangeRequestStageKind::RemoteShare,
        ),
        review_request_count: stage_kind_count(
            &projection,
            AdapterNeutralChangeRequestStageKind::ReviewRequest,
        ),
        unsupported_stage_count: stage_kind_count(
            &projection,
            AdapterNeutralChangeRequestStageKind::Unsupported,
        ),
        git_like_provider_ref_count: projection
            .stages
            .iter()
            .filter(|stage| {
                matches!(
                    stage.provider_ref,
                    AdapterNeutralChangeRequestProviderStageRef::GitLike { .. }
                )
            })
            .count(),
        convergence_like_provider_ref_count: projection
            .stages
            .iter()
            .filter(|stage| {
                matches!(
                    stage.provider_ref,
                    AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike { .. }
                )
            })
            .count(),
        unsupported_provider_ref_count: projection
            .stages
            .iter()
            .filter(|stage| {
                matches!(
                    stage.provider_ref,
                    AdapterNeutralChangeRequestProviderStageRef::Unsupported { .. }
                )
            })
            .count(),
        blocker_count: projection
            .stages
            .iter()
            .map(|stage| stage.blockers.len())
            .sum(),
        branch_or_snapshot_authority_granted: false,
        local_revision_authority_granted: false,
        remote_share_authority_granted: false,
        review_request_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn status_count(
    projection: &AdapterNeutralChangeRequestChainProjection,
    status: AdapterNeutralChangeRequestChainStageStatus,
) -> usize {
    projection
        .stages
        .iter()
        .filter(|stage| stage.status == status)
        .count()
}

fn stage_kind_count(
    projection: &AdapterNeutralChangeRequestChainProjection,
    stage_kind: AdapterNeutralChangeRequestStageKind,
) -> usize {
    projection
        .stages
        .iter()
        .filter(|stage| stage.neutral_stage == stage_kind)
        .count()
}

#[cfg(test)]
#[path = "provider_adapter_neutral_change_request_chain_diagnostics/tests.rs"]
mod tests;
