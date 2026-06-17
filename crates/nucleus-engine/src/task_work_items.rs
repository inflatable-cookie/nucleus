//! Engine-owned task agent work item records.
//!
//! A work item is the unit Nucleus can delegate, recover, validate, and review
//! without copying provider transcripts or raw runtime streams into task state.

use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskTimelineEntryId,
};

/// Stable id for one task-owned work item.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineTaskWorkItemId(pub String);

/// Portable work item record owned by a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRecord {
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub intent: TaskActionType,
    pub assignment: EngineTaskWorkItemAssignment,
    pub runtime: EngineTaskWorkItemRuntimeState,
    pub review: EngineTaskWorkItemReviewState,
    pub refs: EngineTaskWorkItemRefs,
    pub summary: Option<String>,
}

/// Assignment target selected for one work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemAssignment {
    Operator(String),
    AdapterInstance {
        adapter_id: String,
        provider_instance_id: String,
    },
    Mixed(Vec<String>),
    Unassigned,
}

/// Runtime state is separate from review and task acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeState {
    Draft,
    Ready,
    Scheduled,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    Completed,
    Cancelled,
    Failed(String),
    RecoveryRequired(String),
}

/// Operator review state is separate from provider completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewState {
    NotReady,
    AwaitingReview,
    Accepted,
    Rejected(String),
    NeedsChanges(String),
    Abandoned(String),
}

/// References from a work item to runtime evidence.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineTaskWorkItemRefs {
    pub session_id: Option<AgentSessionId>,
    pub turn_ids: Vec<AgentTurnId>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub diff_summary_ids: Vec<EngineDiffSummaryRecordId>,
    pub timeline_entry_ids: Vec<EngineTaskTimelineEntryId>,
    pub validation_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
}

/// Task-scoped grouping of work items.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemSet {
    pub task_id: TaskId,
    pub work_items: Vec<EngineTaskWorkItemRecord>,
}

/// Deterministic projection of one work item's linked runtime evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRuntimeProjection {
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub state: EngineTaskWorkItemRuntimeLinkState,
    pub entries: Vec<EngineTaskWorkItemRuntimeProjectionEntry>,
    pub summary: String,
}

/// Runtime linkage health for a work item projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeLinkState {
    Linked,
    Partial,
    RepairRequired(String),
}

/// Sanitized projection entry derived from a linked runtime ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRuntimeProjectionEntry {
    pub entry_id: String,
    pub kind: EngineTaskWorkItemRuntimeProjectionEntryKind,
    pub source_ref: String,
    pub summary: String,
}

/// Supported projection entry classes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeProjectionEntryKind {
    Session,
    Turn,
    Receipt,
    Checkpoint,
    DiffSummary,
    Timeline,
    Validation,
    Artifact,
}

/// Operator review decision applied to a work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemReviewDecision {
    pub reviewer_ref: String,
    pub outcome: EngineTaskWorkItemReviewOutcome,
    pub validation_refs: Vec<String>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub note: Option<String>,
}

/// Review outcomes that do not directly mutate task completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewOutcome {
    Accept,
    Reject { reason: String },
    NeedsChanges { reason: String },
    Abandon { reason: String },
}

/// Result of applying a review decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemReviewTransition {
    pub work_item: EngineTaskWorkItemRecord,
    pub from: EngineTaskWorkItemReviewState,
    pub to: EngineTaskWorkItemReviewState,
    pub reviewer_ref: String,
    pub validation_refs: Vec<String>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub task_completion_allowed: bool,
}

/// Review transition failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewError {
    EmptyReviewer,
    RuntimeNotComplete,
    MissingReviewEvidence,
    EmptyReason,
}

impl EngineTaskWorkItemRecord {
    /// True when provider work may be done but operator acceptance is still
    /// pending.
    pub fn awaits_operator_acceptance(&self) -> bool {
        self.runtime == EngineTaskWorkItemRuntimeState::Completed
            && matches!(self.review, EngineTaskWorkItemReviewState::AwaitingReview)
    }

    /// True when the work item only links to evidence refs, not raw streams.
    pub fn uses_reference_only_runtime_links(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_raw_runtime_term(summary))
            .unwrap_or(true)
    }

    /// Build a deterministic, sanitized runtime-link projection.
    pub fn runtime_projection(&self) -> EngineTaskWorkItemRuntimeProjection {
        let mut entries = Vec::new();

        if let Some(session_id) = &self.refs.session_id {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Session,
                session_id.0.clone(),
                "linked agent session",
            ));
        }
        for turn_id in &self.refs.turn_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Turn,
                turn_id.0.clone(),
                "linked agent turn",
            ));
        }
        for receipt_id in &self.refs.receipt_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Receipt,
                receipt_id.0.clone(),
                "linked runtime receipt",
            ));
        }
        for checkpoint_id in &self.refs.checkpoint_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Checkpoint,
                checkpoint_id.0.clone(),
                "linked checkpoint",
            ));
        }
        for diff_id in &self.refs.diff_summary_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::DiffSummary,
                diff_id.0.clone(),
                "linked diff summary",
            ));
        }
        for timeline_id in &self.refs.timeline_entry_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Timeline,
                timeline_id.0.clone(),
                "linked task timeline entry",
            ));
        }
        for validation_ref in &self.refs.validation_refs {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Validation,
                validation_ref.clone(),
                "linked validation evidence",
            ));
        }
        for artifact_ref in &self.refs.artifact_refs {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Artifact,
                artifact_ref.clone(),
                "linked artifact evidence",
            ));
        }

        let state = runtime_link_state(self);
        let summary = format!(
            "{} runtime links projected for {}",
            entries.len(),
            self.work_item_id.0
        );

        EngineTaskWorkItemRuntimeProjection {
            work_item_id: self.work_item_id.clone(),
            task_id: self.task_id.clone(),
            state,
            entries,
            summary,
        }
    }

    /// Apply an operator review decision without completing the parent task.
    pub fn apply_review_decision(
        &self,
        decision: EngineTaskWorkItemReviewDecision,
    ) -> Result<EngineTaskWorkItemReviewTransition, EngineTaskWorkItemReviewError> {
        validate_review_decision(self, &decision)?;

        let from = self.review.clone();
        let to = review_state_from_outcome(decision.outcome.clone());
        let mut work_item = self.clone();
        work_item.review = to.clone();
        merge_review_refs(&mut work_item, &decision);

        Ok(EngineTaskWorkItemReviewTransition {
            work_item,
            from,
            to,
            reviewer_ref: decision.reviewer_ref,
            validation_refs: decision.validation_refs,
            checkpoint_ids: decision.checkpoint_ids,
            task_completion_allowed: false,
        })
    }
}

impl EngineTaskWorkItemSet {
    /// Return work items belonging to the set task id.
    pub fn records_for_task(&self) -> Vec<&EngineTaskWorkItemRecord> {
        self.work_items
            .iter()
            .filter(|work_item| work_item.task_id == self.task_id)
            .collect()
    }
}

fn contains_forbidden_raw_runtime_term(summary: &str) -> bool {
    ["raw transcript", "raw provider payload", "terminal stream"]
        .iter()
        .any(|term| summary.to_lowercase().contains(term))
}

fn runtime_projection_entry(
    work_item_id: &EngineTaskWorkItemId,
    kind: EngineTaskWorkItemRuntimeProjectionEntryKind,
    source_ref: String,
    summary: &str,
) -> EngineTaskWorkItemRuntimeProjectionEntry {
    EngineTaskWorkItemRuntimeProjectionEntry {
        entry_id: format!("projection:{}:{source_ref}", work_item_id.0),
        kind,
        source_ref,
        summary: summary.to_owned(),
    }
}

fn runtime_link_state(work_item: &EngineTaskWorkItemRecord) -> EngineTaskWorkItemRuntimeLinkState {
    if work_item.refs.session_id.is_none() {
        return EngineTaskWorkItemRuntimeLinkState::RepairRequired(
            "work item is missing an agent session ref".to_owned(),
        );
    }
    if work_item.refs.receipt_ids.is_empty() && work_item.refs.timeline_entry_ids.is_empty() {
        return EngineTaskWorkItemRuntimeLinkState::Partial;
    }
    EngineTaskWorkItemRuntimeLinkState::Linked
}

fn validate_review_decision(
    work_item: &EngineTaskWorkItemRecord,
    decision: &EngineTaskWorkItemReviewDecision,
) -> Result<(), EngineTaskWorkItemReviewError> {
    if decision.reviewer_ref.trim().is_empty() {
        return Err(EngineTaskWorkItemReviewError::EmptyReviewer);
    }
    if work_item.runtime != EngineTaskWorkItemRuntimeState::Completed {
        return Err(EngineTaskWorkItemReviewError::RuntimeNotComplete);
    }
    if decision.validation_refs.is_empty() && decision.checkpoint_ids.is_empty() {
        return Err(EngineTaskWorkItemReviewError::MissingReviewEvidence);
    }
    match &decision.outcome {
        EngineTaskWorkItemReviewOutcome::Reject { reason }
        | EngineTaskWorkItemReviewOutcome::NeedsChanges { reason }
        | EngineTaskWorkItemReviewOutcome::Abandon { reason }
            if reason.trim().is_empty() =>
        {
            Err(EngineTaskWorkItemReviewError::EmptyReason)
        }
        _ => Ok(()),
    }
}

fn review_state_from_outcome(
    outcome: EngineTaskWorkItemReviewOutcome,
) -> EngineTaskWorkItemReviewState {
    match outcome {
        EngineTaskWorkItemReviewOutcome::Accept => EngineTaskWorkItemReviewState::Accepted,
        EngineTaskWorkItemReviewOutcome::Reject { reason } => {
            EngineTaskWorkItemReviewState::Rejected(reason)
        }
        EngineTaskWorkItemReviewOutcome::NeedsChanges { reason } => {
            EngineTaskWorkItemReviewState::NeedsChanges(reason)
        }
        EngineTaskWorkItemReviewOutcome::Abandon { reason } => {
            EngineTaskWorkItemReviewState::Abandoned(reason)
        }
    }
}

fn merge_review_refs(
    work_item: &mut EngineTaskWorkItemRecord,
    decision: &EngineTaskWorkItemReviewDecision,
) {
    for validation_ref in &decision.validation_refs {
        if !work_item.refs.validation_refs.contains(validation_ref) {
            work_item.refs.validation_refs.push(validation_ref.clone());
        }
    }
    for checkpoint_id in &decision.checkpoint_ids {
        if !work_item.refs.checkpoint_ids.contains(checkpoint_id) {
            work_item.refs.checkpoint_ids.push(checkpoint_id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    };

    fn work_item(id: &str, task_id: &str) -> EngineTaskWorkItemRecord {
        EngineTaskWorkItemRecord {
            work_item_id: EngineTaskWorkItemId(id.to_owned()),
            task_id: TaskId(task_id.to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Implement task-backed work item".to_owned(),
            intent: TaskActionType::Execute,
            assignment: EngineTaskWorkItemAssignment::AdapterInstance {
                adapter_id: "adapter:codex-app-server".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
            },
            runtime: EngineTaskWorkItemRuntimeState::Completed,
            review: EngineTaskWorkItemReviewState::AwaitingReview,
            refs: EngineTaskWorkItemRefs {
                session_id: Some(AgentSessionId("session:nucleus".to_owned())),
                turn_ids: vec![AgentTurnId("turn:nucleus".to_owned())],
                receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
                timeline_entry_ids: vec![EngineTaskTimelineEntryId("timeline:1".to_owned())],
                validation_refs: vec!["validation:effigy:qa".to_owned()],
                artifact_refs: vec!["artifact:diff-summary".to_owned()],
            },
            summary: Some("provider completed; awaiting operator review".to_owned()),
        }
    }

    #[test]
    fn task_can_own_multiple_work_items() {
        let set = EngineTaskWorkItemSet {
            task_id: TaskId("task:1".to_owned()),
            work_items: vec![work_item("work:1", "task:1"), work_item("work:2", "task:1")],
        };

        assert_eq!(set.records_for_task().len(), 2);
        assert!(set
            .records_for_task()
            .iter()
            .all(|work_item| work_item.task_id == TaskId("task:1".to_owned())));
    }

    #[test]
    fn work_item_links_runtime_evidence_by_reference() {
        let item = work_item("work:1", "task:1");

        assert_eq!(
            item.refs.session_id,
            Some(AgentSessionId("session:nucleus".to_owned()))
        );
        assert_eq!(
            item.refs.receipt_ids,
            vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())]
        );
        assert_eq!(
            item.refs.checkpoint_ids,
            vec![EngineCheckpointRecordId("checkpoint:1".to_owned())]
        );
        assert_eq!(
            item.refs.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:1".to_owned())]
        );
        assert!(item.uses_reference_only_runtime_links());
    }

    #[test]
    fn provider_completion_does_not_imply_operator_acceptance() {
        let item = work_item("work:1", "task:1");

        assert_eq!(item.runtime, EngineTaskWorkItemRuntimeState::Completed);
        assert_eq!(item.review, EngineTaskWorkItemReviewState::AwaitingReview);
        assert!(item.awaits_operator_acceptance());
    }

    #[test]
    fn work_item_shape_is_adapter_portable() {
        let mut item = work_item("work:1", "task:1");
        item.assignment = EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "adapter:cursor-acp".to_owned(),
            provider_instance_id: "cursor:local-default".to_owned(),
        };

        assert!(matches!(
            item.assignment,
            EngineTaskWorkItemAssignment::AdapterInstance { .. }
        ));
        assert_eq!(item.refs.turn_ids.len(), 1);
    }

    #[test]
    fn work_item_runtime_projection_is_deterministic_and_sanitized() {
        let item = work_item("work:1", "task:1");
        let first = item.runtime_projection();
        let second = item.runtime_projection();

        assert_eq!(first, second);
        assert_eq!(first.state, EngineTaskWorkItemRuntimeLinkState::Linked);
        assert_eq!(first.entries.len(), 8);
        assert!(first.entries.iter().any(|entry| entry.kind
            == EngineTaskWorkItemRuntimeProjectionEntryKind::Receipt
            && entry.source_ref == "receipt:1"));
        assert!(first
            .entries
            .iter()
            .all(|entry| !entry.summary.contains("raw provider payload")));
    }

    #[test]
    fn work_item_runtime_projection_surfaces_missing_session_ref() {
        let mut item = work_item("work:1", "task:1");
        item.refs.session_id = None;

        let projection = item.runtime_projection();

        assert_eq!(
            projection.state,
            EngineTaskWorkItemRuntimeLinkState::RepairRequired(
                "work item is missing an agent session ref".to_owned()
            )
        );
    }

    #[test]
    fn review_acceptance_is_distinct_from_task_completion() {
        let item = work_item("work:1", "task:1");

        let transition = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:effigy:qa".to_owned()],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:review".to_owned())],
                note: Some("accepted after validation".to_owned()),
            })
            .expect("review transition");

        assert_eq!(
            transition.from,
            EngineTaskWorkItemReviewState::AwaitingReview
        );
        assert_eq!(transition.to, EngineTaskWorkItemReviewState::Accepted);
        assert_eq!(
            transition.work_item.review,
            EngineTaskWorkItemReviewState::Accepted
        );
        assert!(!transition.task_completion_allowed);
        assert!(transition
            .work_item
            .refs
            .checkpoint_ids
            .contains(&EngineCheckpointRecordId("checkpoint:review".to_owned())));
    }

    #[test]
    fn review_records_rejected_needs_changes_and_abandoned_outcomes() {
        let item = work_item("work:1", "task:1");

        let rejected = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Reject {
                    reason: "wrong approach".to_owned(),
                },
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                note: None,
            })
            .expect("reject");
        let needs_changes = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::NeedsChanges {
                    reason: "tests missing".to_owned(),
                },
                validation_refs: Vec::new(),
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:review".to_owned())],
                note: None,
            })
            .expect("needs changes");
        let abandoned = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Abandon {
                    reason: "superseded".to_owned(),
                },
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                note: None,
            })
            .expect("abandon");

        assert_eq!(
            rejected.to,
            EngineTaskWorkItemReviewState::Rejected("wrong approach".to_owned())
        );
        assert_eq!(
            needs_changes.to,
            EngineTaskWorkItemReviewState::NeedsChanges("tests missing".to_owned())
        );
        assert_eq!(
            abandoned.to,
            EngineTaskWorkItemReviewState::Abandoned("superseded".to_owned())
        );
    }

    #[test]
    fn review_requires_completed_runtime_and_evidence() {
        let mut item = work_item("work:1", "task:1");
        item.runtime = EngineTaskWorkItemRuntimeState::Running;

        let error = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                note: None,
            })
            .expect_err("running runtime cannot be reviewed");
        assert_eq!(error, EngineTaskWorkItemReviewError::RuntimeNotComplete);

        item.runtime = EngineTaskWorkItemRuntimeState::Completed;
        let error = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: Vec::new(),
                checkpoint_ids: Vec::new(),
                note: None,
            })
            .expect_err("review evidence required");
        assert_eq!(error, EngineTaskWorkItemReviewError::MissingReviewEvidence);
    }
}
