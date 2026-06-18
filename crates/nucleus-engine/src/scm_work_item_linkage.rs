//! Engine-owned linkage between SCM change evidence and task work items.
//!
//! These records connect work items to SCM work sessions, provider-neutral
//! change refs, checkpoints, diff summaries, and receipts. They do not publish,
//! merge, push, open review requests, or call forge APIs.

use nucleus_scm_forge::{ScmChangeRef, ScmSessionCommandId, ScmWorkSessionId};
use nucleus_tasks::TaskId;

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskWorkItemId, EngineTaskWorkItemRecord,
};

/// Stable id for one SCM evidence link.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineScmWorkItemLinkId(pub String);

/// Link between a task work item and captured SCM change evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineScmWorkItemLinkRecord {
    pub link_id: EngineScmWorkItemLinkId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub work_session_id: ScmWorkSessionId,
    pub session_command_ids: Vec<ScmSessionCommandId>,
    pub change_refs: Vec<ScmChangeRef>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub diff_summary_ids: Vec<EngineDiffSummaryRecordId>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub state: EngineScmWorkItemLinkState,
    pub summary: Option<String>,
}

impl EngineScmWorkItemLinkRecord {
    /// Build a linkage record from a task work item and SCM evidence refs.
    pub fn from_work_item(
        link_id: EngineScmWorkItemLinkId,
        work_item: &EngineTaskWorkItemRecord,
        work_session_id: ScmWorkSessionId,
        change_refs: Vec<ScmChangeRef>,
        state: EngineScmWorkItemLinkState,
    ) -> Self {
        Self {
            link_id,
            task_id: work_item.task_id.clone(),
            work_item_id: work_item.work_item_id.clone(),
            work_session_id,
            session_command_ids: Vec::new(),
            change_refs,
            checkpoint_ids: work_item.refs.checkpoint_ids.clone(),
            diff_summary_ids: work_item.refs.diff_summary_ids.clone(),
            receipt_ids: work_item.refs.receipt_ids.clone(),
            state,
            summary: work_item.summary.clone(),
        }
    }

    /// True when checkpoints and diffs are referenced separately from SCM
    /// provider change refs.
    pub fn keeps_checkpoint_diff_refs_separate_from_changes(&self) -> bool {
        let change_ref_values = self
            .change_refs
            .iter()
            .map(|change_ref| change_ref.provider_ref.0.as_str())
            .collect::<Vec<_>>();

        self.checkpoint_ids
            .iter()
            .all(|checkpoint_id| !change_ref_values.contains(&checkpoint_id.0.as_str()))
            && self
                .diff_summary_ids
                .iter()
                .all(|diff_id| !change_ref_values.contains(&diff_id.0.as_str()))
    }

    /// True when missing or superseded SCM evidence must be repaired before
    /// review or publication.
    pub fn requires_repair(&self) -> bool {
        matches!(
            self.state,
            EngineScmWorkItemLinkState::MissingChangeRef { .. }
                | EngineScmWorkItemLinkState::SupersededChangeRef { .. }
                | EngineScmWorkItemLinkState::RepairRequired(_)
        )
    }

    pub fn with_session_command_ids(mut self, command_ids: Vec<ScmSessionCommandId>) -> Self {
        self.session_command_ids = command_ids;
        self
    }

    pub fn has_session_command_evidence(&self) -> bool {
        !self.session_command_ids.is_empty()
    }
}

/// Linkage health for SCM evidence attached to a work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineScmWorkItemLinkState {
    Linked,
    Partial,
    MissingChangeRef {
        missing_ref: String,
    },
    SupersededChangeRef {
        old_ref: String,
        new_ref: Option<String>,
    },
    RepairRequired(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
    use nucleus_projects::ProjectId;
    use nucleus_scm_forge::{ScmChangeKind, ScmProviderRef, ScmRepositoryRefId};
    use nucleus_tasks::TaskActionType;

    use crate::{
        EngineTaskTimelineEntryId, EngineTaskWorkItemAssignment, EngineTaskWorkItemRefs,
        EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
    };

    fn work_item() -> EngineTaskWorkItemRecord {
        EngineTaskWorkItemRecord {
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Link SCM change evidence".to_owned(),
            intent: TaskActionType::Execute,
            assignment: EngineTaskWorkItemAssignment::AdapterInstance {
                adapter_id: "adapter:codex".to_owned(),
                provider_instance_id: "codex:local".to_owned(),
            },
            runtime: EngineTaskWorkItemRuntimeState::Completed,
            review: EngineTaskWorkItemReviewState::AwaitingReview,
            refs: EngineTaskWorkItemRefs {
                session_id: Some(AgentSessionId("session:agent".to_owned())),
                turn_ids: vec![AgentTurnId("turn:1".to_owned())],
                receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:scm".to_owned())],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:scm".to_owned())],
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:scm".to_owned())],
                timeline_entry_ids: vec![EngineTaskTimelineEntryId("timeline:1".to_owned())],
                validation_refs: Vec::new(),
                artifact_refs: Vec::new(),
            },
            summary: Some("SCM evidence captured by reference".to_owned()),
        }
    }

    fn change_ref(kind: ScmChangeKind, provider_ref: &str) -> ScmChangeRef {
        ScmChangeRef {
            repository_id: ScmRepositoryRefId("repo:nucleus".to_owned()),
            kind,
            provider_ref: ScmProviderRef(provider_ref.to_owned()),
            summary: Some("captured change".to_owned()),
        }
    }

    #[test]
    fn work_item_can_reference_captured_scm_change_evidence() {
        let link = EngineScmWorkItemLinkRecord::from_work_item(
            EngineScmWorkItemLinkId("link:1".to_owned()),
            &work_item(),
            ScmWorkSessionId("scm-session:1".to_owned()),
            vec![change_ref(
                ScmChangeKind::Snapshot,
                "convergence:snapshot:1",
            )],
            EngineScmWorkItemLinkState::Linked,
        );

        assert_eq!(link.task_id, TaskId("task:1".to_owned()));
        assert_eq!(link.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
        assert_eq!(
            link.work_session_id,
            ScmWorkSessionId("scm-session:1".to_owned())
        );
        assert_eq!(link.change_refs.len(), 1);
        assert_eq!(
            link.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:scm".to_owned())]
        );
        assert!(!link.requires_repair());
    }

    #[test]
    fn checkpoint_and_diff_refs_stay_separate_from_provider_change_refs() {
        let link = EngineScmWorkItemLinkRecord::from_work_item(
            EngineScmWorkItemLinkId("link:git".to_owned()),
            &work_item(),
            ScmWorkSessionId("scm-session:git".to_owned()),
            vec![change_ref(ScmChangeKind::Commit, "git:commit:abc123")],
            EngineScmWorkItemLinkState::Linked,
        );

        assert!(link.keeps_checkpoint_diff_refs_separate_from_changes());
        assert_ne!(link.checkpoint_ids[0].0, "git:commit:abc123");
        assert_ne!(link.diff_summary_ids[0].0, "git:commit:abc123");
    }

    #[test]
    fn missing_and_superseded_change_refs_surface_as_repair_state() {
        let missing = EngineScmWorkItemLinkRecord::from_work_item(
            EngineScmWorkItemLinkId("link:missing".to_owned()),
            &work_item(),
            ScmWorkSessionId("scm-session:missing".to_owned()),
            Vec::new(),
            EngineScmWorkItemLinkState::MissingChangeRef {
                missing_ref: "snapshot:missing".to_owned(),
            },
        );
        let superseded = EngineScmWorkItemLinkRecord::from_work_item(
            EngineScmWorkItemLinkId("link:superseded".to_owned()),
            &work_item(),
            ScmWorkSessionId("scm-session:superseded".to_owned()),
            vec![change_ref(ScmChangeKind::Snapshot, "snapshot:old")],
            EngineScmWorkItemLinkState::SupersededChangeRef {
                old_ref: "snapshot:old".to_owned(),
                new_ref: Some("snapshot:new".to_owned()),
            },
        );

        assert!(missing.requires_repair());
        assert!(superseded.requires_repair());
    }

    #[test]
    fn scm_session_command_evidence_links_to_work_items_by_reference() {
        let link = EngineScmWorkItemLinkRecord::from_work_item(
            EngineScmWorkItemLinkId("link:session-command".to_owned()),
            &work_item(),
            ScmWorkSessionId("scm-session:command".to_owned()),
            vec![change_ref(ScmChangeKind::Snapshot, "snapshot:captured")],
            EngineScmWorkItemLinkState::Linked,
        )
        .with_session_command_ids(vec![
            ScmSessionCommandId("scm-command:prepare".to_owned()),
            ScmSessionCommandId("scm-command:inspect".to_owned()),
        ]);

        assert!(link.has_session_command_evidence());
        assert_eq!(link.session_command_ids.len(), 2);
        assert!(link.keeps_checkpoint_diff_refs_separate_from_changes());
    }
}
