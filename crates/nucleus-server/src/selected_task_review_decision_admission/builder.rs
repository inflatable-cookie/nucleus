use std::collections::HashSet;

use crate::{
    SelectedTaskReviewDecisionAction, SelectedTaskReviewDecisionAdmission,
    SelectedTaskReviewDecisionAdmissionInput, SelectedTaskReviewDecisionAdmissionRefusal,
    SelectedTaskReviewDecisionAdmissionRefusalKind, SelectedTaskReviewDecisionAdmissionStatus,
    SelectedTaskReviewDecisionCommand, SelectedTaskReviewDecisionIntent,
    SelectedTaskReviewDecisionNoEffects, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReviewState,
};

pub fn selected_task_review_decision_admission(
    input: SelectedTaskReviewDecisionAdmissionInput,
) -> SelectedTaskReviewDecisionAdmission {
    let operator_ref = input.intent.operator_ref.trim().to_owned();
    let evidence_refs = clean_refs(input.intent.reviewed_evidence_refs.clone());
    let decision_id = decision_id(
        &input.review_next.task_id.0,
        input.intent.idempotency_key.as_str(),
    );
    let admission_id = format!(
        "selected-task-review-decision-admission:{}:{:?}",
        input.review_next.task_id.0, input.intent.action
    );

    let result = admission_result(&input, &operator_ref, &evidence_refs, &decision_id);
    let (status, command, refusal) = match result {
        Ok(command) => (
            SelectedTaskReviewDecisionAdmissionStatus::Admitted,
            Some(command),
            None,
        ),
        Err((status, refusal)) => (status, None, Some(refusal)),
    };

    SelectedTaskReviewDecisionAdmission {
        admission_id,
        decision_id,
        project_id: input.review_next.project_id,
        task_id: input.review_next.task_id,
        action: input.intent.action,
        status,
        command,
        refusal,
        operator_ref,
        evidence_refs,
        no_effects: SelectedTaskReviewDecisionNoEffects::pure_admission(),
    }
}

fn admission_result(
    input: &SelectedTaskReviewDecisionAdmissionInput,
    operator_ref: &str,
    evidence_refs: &[String],
    decision_id: &str,
) -> Result<
    SelectedTaskReviewDecisionCommand,
    (
        SelectedTaskReviewDecisionAdmissionStatus,
        SelectedTaskReviewDecisionAdmissionRefusal,
    ),
> {
    if operator_ref.is_empty() {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Blocked,
            SelectedTaskReviewDecisionAdmissionRefusalKind::MissingOperator,
            "operator ref is required",
        );
    }
    if input.intent.idempotency_key.trim().is_empty() {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Blocked,
            SelectedTaskReviewDecisionAdmissionRefusalKind::MissingIdempotencyKey,
            "idempotency key is required",
        );
    }
    let Some(expected_revision) = input.intent.expected_revision.clone() else {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Blocked,
            SelectedTaskReviewDecisionAdmissionRefusalKind::ExpectedRevisionRequired,
            "expected task or review revision is required",
        );
    };
    if input
        .current_revision
        .as_ref()
        .is_some_and(|current| current != &expected_revision)
    {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Stale,
            SelectedTaskReviewDecisionAdmissionRefusalKind::StaleRevision,
            "expected revision does not match the current review revision",
        );
    }
    if input
        .existing_decision_ids
        .iter()
        .any(|existing| existing == decision_id)
    {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Duplicate,
            SelectedTaskReviewDecisionAdmissionRefusalKind::DuplicateDecision,
            "review decision was already admitted for this idempotency key",
        );
    }
    if is_noop(input.intent.action, input.review_next.review.state) {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::NoOp,
            SelectedTaskReviewDecisionAdmissionRefusalKind::DecisionAlreadyRepresented,
            "requested review decision is already represented",
        );
    }
    if !action_allowed(input.intent.action, input.review_next.review.state) {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Unsupported,
            SelectedTaskReviewDecisionAdmissionRefusalKind::ReviewNotAwaitingDecision,
            "selected task review is not awaiting that decision",
        );
    }
    if evidence_refs.is_empty() {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::MissingEvidence,
            SelectedTaskReviewDecisionAdmissionRefusalKind::MissingReviewedEvidence,
            "at least one reviewed evidence ref is required",
        );
    }
    if !evidence_refs_known(evidence_refs, input) {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::MissingEvidence,
            SelectedTaskReviewDecisionAdmissionRefusalKind::UnknownReviewedEvidence,
            "reviewed evidence refs must come from selected-task review evidence",
        );
    }
    if reason_required(input.intent.action) && clean_reason(&input.intent).is_none() {
        return refused(
            SelectedTaskReviewDecisionAdmissionStatus::Blocked,
            SelectedTaskReviewDecisionAdmissionRefusalKind::ReasonRequired,
            "reason is required for this review decision",
        );
    }

    Ok(SelectedTaskReviewDecisionCommand {
        decision_id: decision_id.to_owned(),
        project_id: input.review_next.project_id.clone(),
        task_id: input.review_next.task_id.clone(),
        action: input.intent.action,
        outcome: outcome(input.intent.action),
        expected_revision,
        operator_ref: operator_ref.to_owned(),
        reviewed_evidence_refs: evidence_refs.to_vec(),
        idempotency_key: input.intent.idempotency_key.trim().to_owned(),
        reason: clean_reason(&input.intent),
    })
}

fn refused<T>(
    status: SelectedTaskReviewDecisionAdmissionStatus,
    kind: SelectedTaskReviewDecisionAdmissionRefusalKind,
    reason: &'static str,
) -> Result<
    T,
    (
        SelectedTaskReviewDecisionAdmissionStatus,
        SelectedTaskReviewDecisionAdmissionRefusal,
    ),
> {
    Err((
        status,
        SelectedTaskReviewDecisionAdmissionRefusal {
            kind,
            reason: reason.to_owned(),
        },
    ))
}

fn action_allowed(
    action: SelectedTaskReviewDecisionAction,
    state: SelectedTaskReviewState,
) -> bool {
    match action {
        SelectedTaskReviewDecisionAction::AcceptEvidence
        | SelectedTaskReviewDecisionAction::RejectEvidence
        | SelectedTaskReviewDecisionAction::RequestChanges => {
            state == SelectedTaskReviewState::AwaitingReview
        }
        SelectedTaskReviewDecisionAction::AbandonReview => matches!(
            state,
            SelectedTaskReviewState::AwaitingReview
                | SelectedTaskReviewState::NeedsChanges
                | SelectedTaskReviewState::Rejected
        ),
    }
}

fn is_noop(action: SelectedTaskReviewDecisionAction, state: SelectedTaskReviewState) -> bool {
    matches!(
        (action, state),
        (
            SelectedTaskReviewDecisionAction::AcceptEvidence,
            SelectedTaskReviewState::Accepted
        ) | (
            SelectedTaskReviewDecisionAction::RejectEvidence,
            SelectedTaskReviewState::Rejected
        ) | (
            SelectedTaskReviewDecisionAction::RequestChanges,
            SelectedTaskReviewState::NeedsChanges
        ) | (
            SelectedTaskReviewDecisionAction::AbandonReview,
            SelectedTaskReviewState::Abandoned
        )
    )
}

fn outcome(action: SelectedTaskReviewDecisionAction) -> SelectedTaskReviewDecisionOutcome {
    match action {
        SelectedTaskReviewDecisionAction::AcceptEvidence => {
            SelectedTaskReviewDecisionOutcome::Accepted
        }
        SelectedTaskReviewDecisionAction::RejectEvidence => {
            SelectedTaskReviewDecisionOutcome::Rejected
        }
        SelectedTaskReviewDecisionAction::RequestChanges => {
            SelectedTaskReviewDecisionOutcome::NeedsChanges
        }
        SelectedTaskReviewDecisionAction::AbandonReview => {
            SelectedTaskReviewDecisionOutcome::Abandoned
        }
    }
}

fn reason_required(action: SelectedTaskReviewDecisionAction) -> bool {
    !matches!(action, SelectedTaskReviewDecisionAction::AcceptEvidence)
}

fn clean_reason(intent: &SelectedTaskReviewDecisionIntent) -> Option<String> {
    intent
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(str::to_owned)
}

fn evidence_refs_known(
    evidence_refs: &[String],
    input: &SelectedTaskReviewDecisionAdmissionInput,
) -> bool {
    let known = known_evidence_refs(input);
    evidence_refs
        .iter()
        .all(|reference| known.contains(reference))
}

fn known_evidence_refs(input: &SelectedTaskReviewDecisionAdmissionInput) -> HashSet<String> {
    input
        .review_next
        .review
        .evidence_refs
        .iter()
        .chain(input.review_next.evidence.receipt_refs.iter())
        .chain(input.review_next.evidence.checkpoint_refs.iter())
        .chain(input.review_next.evidence.diff_summary_refs.iter())
        .chain(input.review_next.evidence.validation_refs.iter())
        .chain(input.review_next.evidence.timeline_refs.iter())
        .chain(input.review_next.evidence.review_refs.iter())
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect()
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .filter(|reference| seen.insert(reference.clone()))
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned
}

fn decision_id(task_id: &str, idempotency_key: &str) -> String {
    format!(
        "selected-task-review-decision:{task_id}:{}",
        stable_token(idempotency_key)
    )
}

fn stable_token(value: &str) -> String {
    let token = value
        .trim()
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | ':' | '-' | '_' | '.' => character,
            _ => '_',
        })
        .collect::<String>();
    if token.is_empty() {
        "missing".to_owned()
    } else {
        token
    }
}
