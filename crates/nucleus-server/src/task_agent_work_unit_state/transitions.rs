use nucleus_engine::{
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceRecord, EngineTaskWorkItemRefs,
};
use nucleus_local_store::{LocalStoreError, LocalStoreResult};

pub(super) fn validate_initial_source_record(
    record: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()> {
    if !matches!(
        record.runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Draft
            | EngineTaskAgentWorkUnitRuntimeStatus::Ready
            | EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
    ) {
        return invalid_transition("first source record must start at draft, ready, or scheduled");
    }
    if !matches!(record.review, EngineTaskAgentWorkUnitReviewStatus::NotReady) {
        return invalid_transition("first source record review state must be not_ready");
    }
    Ok(())
}

pub(super) fn validate_source_record_transition(
    previous: &EngineTaskAgentWorkUnitSourceRecord,
    next: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()> {
    if previous.work_item_id != next.work_item_id {
        return invalid_transition("source record previous_source_id crosses work items");
    }
    if previous.project_id != next.project_id || previous.task_id != next.task_id {
        return invalid_transition("source record project/task identity changed");
    }
    if next.source_cursor.0 <= previous.source_cursor.0 {
        return invalid_transition("source cursor must increase across source-record transition");
    }
    validate_runtime_transition(&previous.runtime, &next.runtime)?;
    validate_review_transition(previous, next)?;
    Ok(())
}

fn validate_runtime_transition(
    previous: &EngineTaskAgentWorkUnitRuntimeStatus,
    next: &EngineTaskAgentWorkUnitRuntimeStatus,
) -> LocalStoreResult<()> {
    if previous == next {
        return Ok(());
    }
    let allowed = matches!(
        (previous, next),
        (
            EngineTaskAgentWorkUnitRuntimeStatus::Draft,
            EngineTaskAgentWorkUnitRuntimeStatus::Ready
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Ready,
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput,
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput,
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_),
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_),
            EngineTaskAgentWorkUnitRuntimeStatus::Ready
        )
    );
    if allowed {
        Ok(())
    } else {
        invalid_transition(format!(
            "invalid runtime transition: {previous:?} -> {next:?}"
        ))
    }
}

fn validate_review_transition(
    previous: &EngineTaskAgentWorkUnitSourceRecord,
    next: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()> {
    if previous.review == next.review {
        return Ok(());
    }
    match (&previous.review, &next.review) {
        (
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
        ) => validate_awaiting_review_entry(next),
        (
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
            EngineTaskAgentWorkUnitReviewStatus::Accepted,
        )
        | (
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
            EngineTaskAgentWorkUnitReviewStatus::Rejected(_),
        )
        | (
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
            EngineTaskAgentWorkUnitReviewStatus::NeedsChanges(_),
        )
        | (
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
            EngineTaskAgentWorkUnitReviewStatus::Abandoned(_),
        ) => Ok(()),
        (
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            EngineTaskAgentWorkUnitReviewStatus::Abandoned(_),
        ) if matches!(
            next.runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        ) && has_review_evidence(&next.refs) =>
        {
            Ok(())
        }
        _ => invalid_transition(format!(
            "invalid review transition: {:?} -> {:?}",
            previous.review, next.review
        )),
    }
}

fn validate_awaiting_review_entry(
    record: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()> {
    if !matches!(
        record.runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Completed
    ) {
        return invalid_transition("awaiting review requires completed runtime");
    }
    if !has_review_evidence(&record.refs) {
        return invalid_transition("awaiting review requires review evidence refs");
    }
    Ok(())
}

fn has_review_evidence(refs: &EngineTaskWorkItemRefs) -> bool {
    !refs.validation_refs.is_empty()
        || !refs.checkpoint_ids.is_empty()
        || !refs.diff_summary_ids.is_empty()
        || !refs.receipt_ids.is_empty()
        || refs
            .artifact_refs
            .iter()
            .any(|reference| reference == "evidence:no-change")
}

fn invalid_transition<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}
