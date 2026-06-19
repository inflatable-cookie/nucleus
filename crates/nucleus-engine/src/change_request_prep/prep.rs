use nucleus_scm_forge::{ForgeProviderKind, ScmChangeRef, ScmWorkSessionId};
use nucleus_tasks::TaskId;

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineScmWorkItemLinkRecord, EngineTaskWorkItemId,
};

use super::target::{
    EngineChangeRequestPrepStatus, EngineChangeRequestPublicationState,
    EngineChangeRequestReviewPolicy, EngineChangeRequestTarget,
};

/// Stable id for one prepared change request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineChangeRequestPrepId(pub String);

/// Prepared change request handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineChangeRequestPrepRecord {
    pub prep_id: EngineChangeRequestPrepId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub work_session_id: ScmWorkSessionId,
    pub target: EngineChangeRequestTarget,
    pub change_refs: Vec<ScmChangeRef>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub diff_summary_ids: Vec<EngineDiffSummaryRecordId>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub publication: EngineChangeRequestPublicationState,
    pub review_policy: EngineChangeRequestReviewPolicy,
    pub status: EngineChangeRequestPrepStatus,
    pub summary: Option<String>,
}

impl EngineChangeRequestPrepRecord {
    /// Prepare a handoff record from an existing SCM work-item evidence link.
    pub fn from_scm_link(
        prep_id: EngineChangeRequestPrepId,
        link: &EngineScmWorkItemLinkRecord,
        target: EngineChangeRequestTarget,
        review_policy: EngineChangeRequestReviewPolicy,
    ) -> Self {
        Self {
            prep_id,
            task_id: link.task_id.clone(),
            work_item_id: link.work_item_id.clone(),
            work_session_id: link.work_session_id.clone(),
            target,
            change_refs: link.change_refs.clone(),
            checkpoint_ids: link.checkpoint_ids.clone(),
            diff_summary_ids: link.diff_summary_ids.clone(),
            receipt_ids: link.receipt_ids.clone(),
            publication: EngineChangeRequestPublicationState::NotRequested,
            review_policy,
            status: EngineChangeRequestPrepStatus::Draft,
            summary: link.summary.clone(),
        }
    }

    pub fn is_prep_only(&self) -> bool {
        self.publication == EngineChangeRequestPublicationState::NotRequested
            && matches!(
                self.status,
                EngineChangeRequestPrepStatus::Draft | EngineChangeRequestPrepStatus::Ready
            )
    }

    pub fn preserves_non_git_target(&self) -> bool {
        matches!(
            self.target,
            EngineChangeRequestTarget::ProviderPublication { .. }
                | EngineChangeRequestTarget::ProviderGate { .. }
                | EngineChangeRequestTarget::ManualHandoff
                | EngineChangeRequestTarget::Custom(_)
        )
    }

    pub fn targets_github_review(&self) -> bool {
        matches!(
            self.target,
            EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                ..
            }
        )
    }
}
