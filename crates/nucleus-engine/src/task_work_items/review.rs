use super::types::{
    EngineTaskWorkItemRecord, EngineTaskWorkItemReviewCommand, EngineTaskWorkItemReviewDecision,
    EngineTaskWorkItemReviewError, EngineTaskWorkItemReviewOutcome, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemReviewTimelineEntry, EngineTaskWorkItemReviewTransition,
    EngineTaskWorkItemRuntimeState,
};

impl EngineTaskWorkItemRecord {
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
            diff_summary_ids: decision.diff_summary_ids,
            task_completion_allowed: false,
        })
    }

    /// Apply a review command with expected-state protection.
    pub fn apply_review_command(
        &self,
        command: EngineTaskWorkItemReviewCommand,
    ) -> Result<EngineTaskWorkItemReviewTransition, EngineTaskWorkItemReviewError> {
        if command.work_item_id != self.work_item_id {
            return Err(EngineTaskWorkItemReviewError::WorkItemMismatch);
        }
        if let Some(expected) = command.expected_review.as_ref() {
            if expected != &self.review {
                return Err(EngineTaskWorkItemReviewError::ReviewStateConflict);
            }
        }
        self.apply_review_decision(command.decision)
    }
}

pub fn review_timeline_entry_from_transition(
    command_id: &str,
    transition: &EngineTaskWorkItemReviewTransition,
) -> EngineTaskWorkItemReviewTimelineEntry {
    EngineTaskWorkItemReviewTimelineEntry {
        entry_id: format!("timeline:{}:{}", transition.work_item.task_id.0, command_id),
        task_id: transition.work_item.task_id.clone(),
        work_item_id: transition.work_item.work_item_id.clone(),
        source_command_id: command_id.to_owned(),
        review_state: transition.to.clone(),
        checkpoint_ids: transition.checkpoint_ids.clone(),
        diff_summary_ids: transition.diff_summary_ids.clone(),
        summary: format!("work item review moved to {:?}", transition.to),
    }
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
    if decision.validation_refs.is_empty()
        && decision.checkpoint_ids.is_empty()
        && decision.diff_summary_ids.is_empty()
    {
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
    for diff_summary_id in &decision.diff_summary_ids {
        if !work_item.refs.diff_summary_ids.contains(diff_summary_id) {
            work_item
                .refs
                .diff_summary_ids
                .push(diff_summary_id.clone());
        }
    }
}
