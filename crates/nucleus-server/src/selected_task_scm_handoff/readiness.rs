use crate::{
    SelectedTaskScmHandoffEvidence, SelectedTaskScmHandoffGap, SelectedTaskScmHandoffState,
    SelectedTaskScmHandoffSummary,
};

pub fn readiness_summary(
    evidence: &SelectedTaskScmHandoffEvidence,
    gaps: &[SelectedTaskScmHandoffGap],
) -> SelectedTaskScmHandoffSummary {
    let state = readiness_state(evidence, gaps);
    let reason = match state {
        SelectedTaskScmHandoffState::Missing => {
            "no SCM handoff evidence exists for the selected task"
        }
        SelectedTaskScmHandoffState::Blocked => {
            "SCM handoff evidence exists but required review refs are missing"
        }
        SelectedTaskScmHandoffState::EvidenceReady => {
            "SCM handoff evidence is ready for change-request preparation"
        }
        SelectedTaskScmHandoffState::PrepReady => {
            "change-request preparation evidence is ready for operator review"
        }
        SelectedTaskScmHandoffState::PublicationPending => {
            "handoff target is named but publication is not executed"
        }
        SelectedTaskScmHandoffState::Represented => {
            "SCM handoff is already represented by provider-neutral refs"
        }
        SelectedTaskScmHandoffState::RepairRequired => {
            "SCM handoff evidence requires repair before use"
        }
    };

    SelectedTaskScmHandoffSummary {
        state,
        reason: reason.to_owned(),
        handoff_refs: evidence.scm_handoff_refs.clone(),
        blocker_refs: gaps.iter().map(|gap| format!("{:?}", gap.area)).collect(),
    }
}

fn readiness_state(
    evidence: &SelectedTaskScmHandoffEvidence,
    gaps: &[SelectedTaskScmHandoffGap],
) -> SelectedTaskScmHandoffState {
    if !evidence.repair_refs.is_empty() {
        return SelectedTaskScmHandoffState::RepairRequired;
    }
    if evidence.scm_handoff_refs.is_empty() {
        return SelectedTaskScmHandoffState::Missing;
    }
    if evidence
        .scm_handoff_refs
        .iter()
        .any(|reference| contains(reference, &["represented", "published", "opened"]))
    {
        return SelectedTaskScmHandoffState::Represented;
    }
    if evidence
        .scm_handoff_refs
        .iter()
        .any(|reference| contains(reference, &["publication-pending", "publish-pending"]))
    {
        return SelectedTaskScmHandoffState::PublicationPending;
    }
    if !evidence.change_request_prep_refs.is_empty()
        && evidence.checkpoint_refs.len() > 0
        && evidence.diff_summary_refs.len() > 0
        && evidence.runtime_receipt_refs.len() > 0
        && evidence.review_refs.len() > 0
    {
        return SelectedTaskScmHandoffState::PrepReady;
    }
    if gaps.is_empty()
        || (!evidence.scm_work_session_refs.is_empty()
            && !evidence.provider_change_refs.is_empty()
            && !evidence.checkpoint_refs.is_empty()
            && !evidence.diff_summary_refs.is_empty()
            && !evidence.runtime_receipt_refs.is_empty()
            && !evidence.review_refs.is_empty())
    {
        return SelectedTaskScmHandoffState::EvidenceReady;
    }

    SelectedTaskScmHandoffState::Blocked
}

fn contains(reference: &str, needles: &[&str]) -> bool {
    let reference = reference.to_ascii_lowercase();
    needles.iter().any(|needle| reference.contains(needle))
}
