use crate::{
    SelectedTaskScmHandoffEvidence, SelectedTaskScmHandoffGap, SelectedTaskScmHandoffNextCategory,
    SelectedTaskScmHandoffNextStep, SelectedTaskScmHandoffState, SelectedTaskScmHandoffSummary,
    SelectedTaskScmHandoffTarget,
};

pub fn next_step(
    readiness: &SelectedTaskScmHandoffSummary,
    target: &SelectedTaskScmHandoffTarget,
    evidence: &SelectedTaskScmHandoffEvidence,
    gaps: &[SelectedTaskScmHandoffGap],
) -> SelectedTaskScmHandoffNextStep {
    match readiness.state {
        SelectedTaskScmHandoffState::Missing => step(
            SelectedTaskScmHandoffNextCategory::PlanningAmbiguity,
            "Capture SCM handoff evidence before preparing a change request",
            None,
            gaps.iter().map(|gap| format!("{:?}", gap.area)).collect(),
        ),
        SelectedTaskScmHandoffState::Blocked => step(
            SelectedTaskScmHandoffNextCategory::InspectEvidence,
            "Inspect missing SCM handoff evidence",
            evidence.scm_handoff_refs.first().cloned(),
            gaps.iter().map(|gap| format!("{:?}", gap.area)).collect(),
        ),
        SelectedTaskScmHandoffState::EvidenceReady => step(
            SelectedTaskScmHandoffNextCategory::PrepareChangeRequest,
            "Prepare a provider-neutral change-request package",
            evidence.scm_handoff_refs.first().cloned(),
            evidence.scm_handoff_refs.clone(),
        ),
        SelectedTaskScmHandoffState::PrepReady => step(
            SelectedTaskScmHandoffNextCategory::ReviewPreparation,
            "Review the prepared handoff package",
            evidence.change_request_prep_refs.first().cloned(),
            evidence.change_request_prep_refs.clone(),
        ),
        SelectedTaskScmHandoffState::PublicationPending => step(
            SelectedTaskScmHandoffNextCategory::PublishHandoff,
            "Publication target is pending explicit operator action",
            target
                .target_refs
                .first()
                .cloned()
                .or_else(|| evidence.scm_handoff_refs.first().cloned()),
            target.target_refs.clone(),
        ),
        SelectedTaskScmHandoffState::Represented => step(
            SelectedTaskScmHandoffNextCategory::Wait,
            "SCM handoff is represented; wait for review or publication outcome",
            target
                .target_refs
                .first()
                .cloned()
                .or_else(|| evidence.scm_handoff_refs.first().cloned()),
            target.target_refs.clone(),
        ),
        SelectedTaskScmHandoffState::RepairRequired => step(
            SelectedTaskScmHandoffNextCategory::Repair,
            "Repair SCM handoff refs before use",
            evidence.repair_refs.first().cloned(),
            evidence.repair_refs.clone(),
        ),
    }
}

fn step(
    category: SelectedTaskScmHandoffNextCategory,
    summary: &str,
    next_ref: Option<String>,
    rationale_refs: Vec<String>,
) -> SelectedTaskScmHandoffNextStep {
    SelectedTaskScmHandoffNextStep {
        category,
        summary: summary.to_owned(),
        next_ref,
        rationale_refs,
    }
}
