//! Engine-owned change-request preparation records.
//!
//! These records describe the handoff Nucleus may later publish through an SCM
//! or forge adapter. They do not create pull requests, publish snapshots,
//! merge, push, promote, resolve credentials, or call remote APIs.

use nucleus_scm_forge::{ForgeProviderKind, ScmBranchRef, ScmChangeRef, ScmWorkSessionId};
use nucleus_tasks::TaskId;

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineScmWorkItemLinkRecord, EngineTaskWorkItemId,
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
}

/// Neutral target for a future change request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestTarget {
    ForgeReview {
        provider: ForgeProviderKind,
        target_branch: Option<ScmBranchRef>,
    },
    ProviderPublication {
        publication_ref: Option<String>,
        gate_ref: Option<String>,
    },
    ProviderGate {
        gate_ref: Option<String>,
    },
    DirectAuthorityUpdate {
        target_ref: Option<String>,
    },
    ManualHandoff,
    Custom(String),
}

/// Publication state for a prep record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPublicationState {
    NotRequested,
    WaitingForApproval,
    PublicationRequested,
    Published { provider_ref: String },
    Rejected(String),
    Unsupported(String),
}

/// Review policy expected before shared authority changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestReviewPolicy {
    HumanReviewRequired,
    StewardMayPrepareOnly,
    DirectAuthorityUpdateAllowed,
    Unsupported,
}

/// Prep lifecycle before provider publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPrepStatus {
    Draft,
    Ready,
    Blocked(String),
    Superseded(String),
    Abandoned(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_scm_forge::{ScmChangeKind, ScmProviderRef, ScmRepositoryRefId, ScmWorkSessionId};

    use crate::{EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState};

    fn change_ref(kind: ScmChangeKind, provider_ref: &str) -> ScmChangeRef {
        ScmChangeRef {
            repository_id: ScmRepositoryRefId("repo:nucleus".to_owned()),
            kind,
            provider_ref: ScmProviderRef(provider_ref.to_owned()),
            summary: Some("captured change".to_owned()),
        }
    }

    fn scm_link(change_ref: ScmChangeRef) -> EngineScmWorkItemLinkRecord {
        EngineScmWorkItemLinkRecord {
            link_id: EngineScmWorkItemLinkId("link:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            work_session_id: ScmWorkSessionId("session:scm".to_owned()),
            change_refs: vec![change_ref],
            checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
            diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
            receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
            state: EngineScmWorkItemLinkState::Linked,
            summary: Some("ready for handoff prep".to_owned()),
        }
    }

    #[test]
    fn forge_review_prep_is_distinct_from_publication() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:github".to_owned()),
            &scm_link(change_ref(ScmChangeKind::Commit, "git:commit:abc123")),
            EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                target_branch: None,
            },
            EngineChangeRequestReviewPolicy::HumanReviewRequired,
        );

        assert!(prep.is_prep_only());
        assert_eq!(
            prep.publication,
            EngineChangeRequestPublicationState::NotRequested
        );
        assert_eq!(
            prep.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:1".to_owned())]
        );
        assert!(matches!(
            prep.target,
            EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                ..
            }
        ));
    }

    #[test]
    fn convergence_style_publication_target_remains_viable() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:convergence".to_owned()),
            &scm_link(change_ref(
                ScmChangeKind::Snapshot,
                "convergence:snapshot:abc123",
            )),
            EngineChangeRequestTarget::ProviderPublication {
                publication_ref: Some("convergence:publication:draft".to_owned()),
                gate_ref: Some("convergence:gate:review".to_owned()),
            },
            EngineChangeRequestReviewPolicy::StewardMayPrepareOnly,
        );

        assert!(prep.is_prep_only());
        assert!(prep.preserves_non_git_target());
        assert_eq!(prep.change_refs[0].kind, ScmChangeKind::Snapshot);
    }

    #[test]
    fn prep_record_keeps_pr_shape_out_of_storage_model() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:manual".to_owned()),
            &scm_link(change_ref(ScmChangeKind::Patch, "patch:series:1")),
            EngineChangeRequestTarget::ManualHandoff,
            EngineChangeRequestReviewPolicy::HumanReviewRequired,
        );

        assert!(prep.preserves_non_git_target());
        assert_eq!(prep.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
        assert_eq!(
            prep.checkpoint_ids,
            vec![EngineCheckpointRecordId("checkpoint:1".to_owned())]
        );
        assert!(matches!(
            prep.target,
            EngineChangeRequestTarget::ManualHandoff
        ));
    }
}
