use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskScmHandoffEvidence, SelectedTaskScmHandoffGap, SelectedTaskScmHandoffGapArea,
    SelectedTaskScmHandoffNextCategory, SelectedTaskScmHandoffNextStep,
    SelectedTaskScmHandoffNoEffects, SelectedTaskScmHandoffReadiness,
    SelectedTaskScmHandoffSourceCounts, SelectedTaskScmHandoffState, SelectedTaskScmHandoffSummary,
    SelectedTaskScmHandoffTarget, SelectedTaskScmHandoffTargetShape,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffDto {
    pub handoff_id: String,
    pub project_id: String,
    pub task_id: String,
    pub readiness: ControlSelectedTaskScmHandoffSummaryDto,
    pub target: ControlSelectedTaskScmHandoffTargetDto,
    pub evidence: ControlSelectedTaskScmHandoffEvidenceDto,
    pub next: ControlSelectedTaskScmHandoffNextStepDto,
    pub source_counts: ControlSelectedTaskScmHandoffSourceCountsDto,
    pub gaps: Vec<ControlSelectedTaskScmHandoffGapDto>,
    pub no_effects: ControlSelectedTaskScmHandoffNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffSummaryDto {
    pub state: String,
    pub reason: String,
    pub handoff_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffTargetDto {
    pub shape: String,
    pub target_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffEvidenceDto {
    pub work_item_refs: Vec<String>,
    pub scm_handoff_refs: Vec<String>,
    pub scm_work_session_refs: Vec<String>,
    pub provider_change_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub runtime_receipt_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub review_refs: Vec<String>,
    pub change_request_prep_refs: Vec<String>,
    pub repair_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffNextStepDto {
    pub category: String,
    pub summary: String,
    pub next_ref: Option<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffSourceCountsDto {
    #[ts(as = "u32")]
    pub task_records: usize,
    #[ts(as = "u32")]
    pub work_items: usize,
    #[ts(as = "u32")]
    pub scm_handoff_refs: usize,
    #[ts(as = "u32")]
    pub scm_work_session_refs: usize,
    #[ts(as = "u32")]
    pub provider_change_refs: usize,
    #[ts(as = "u32")]
    pub checkpoint_refs: usize,
    #[ts(as = "u32")]
    pub diff_summary_refs: usize,
    #[ts(as = "u32")]
    pub runtime_receipt_refs: usize,
    #[ts(as = "u32")]
    pub validation_refs: usize,
    #[ts(as = "u32")]
    pub review_refs: usize,
    #[ts(as = "u32")]
    pub change_request_prep_refs: usize,
    #[ts(as = "u32")]
    pub repair_refs: usize,
    #[ts(as = "u32")]
    pub gap_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffGapDto {
    pub area: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskScmHandoffNoEffectsDto {
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub credential_resolution_performed: bool,
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub review_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub ui_effect_performed: bool,
}

impl From<&SelectedTaskScmHandoffReadiness> for ControlSelectedTaskScmHandoffDto {
    fn from(handoff: &SelectedTaskScmHandoffReadiness) -> Self {
        Self {
            handoff_id: handoff.handoff_id.clone(),
            project_id: handoff.project_id.0.clone(),
            task_id: handoff.task_id.0.clone(),
            readiness: ControlSelectedTaskScmHandoffSummaryDto::from(&handoff.readiness),
            target: ControlSelectedTaskScmHandoffTargetDto::from(&handoff.target),
            evidence: ControlSelectedTaskScmHandoffEvidenceDto::from(&handoff.evidence),
            next: ControlSelectedTaskScmHandoffNextStepDto::from(&handoff.next),
            source_counts: ControlSelectedTaskScmHandoffSourceCountsDto::from(
                &handoff.source_counts,
            ),
            gaps: handoff
                .gaps
                .iter()
                .map(ControlSelectedTaskScmHandoffGapDto::from)
                .collect(),
            no_effects: ControlSelectedTaskScmHandoffNoEffectsDto::from(&handoff.no_effects),
        }
    }
}

impl From<&SelectedTaskScmHandoffSummary> for ControlSelectedTaskScmHandoffSummaryDto {
    fn from(summary: &SelectedTaskScmHandoffSummary) -> Self {
        Self {
            state: readiness_state_label(summary.state).to_owned(),
            reason: summary.reason.clone(),
            handoff_refs: summary.handoff_refs.clone(),
            blocker_refs: summary.blocker_refs.clone(),
        }
    }
}

impl From<&SelectedTaskScmHandoffTarget> for ControlSelectedTaskScmHandoffTargetDto {
    fn from(target: &SelectedTaskScmHandoffTarget) -> Self {
        Self {
            shape: target_shape_label(target.shape).to_owned(),
            target_refs: target.target_refs.clone(),
        }
    }
}

impl From<&SelectedTaskScmHandoffEvidence> for ControlSelectedTaskScmHandoffEvidenceDto {
    fn from(evidence: &SelectedTaskScmHandoffEvidence) -> Self {
        Self {
            work_item_refs: evidence.work_item_refs.clone(),
            scm_handoff_refs: evidence.scm_handoff_refs.clone(),
            scm_work_session_refs: evidence.scm_work_session_refs.clone(),
            provider_change_refs: evidence.provider_change_refs.clone(),
            checkpoint_refs: evidence.checkpoint_refs.clone(),
            diff_summary_refs: evidence.diff_summary_refs.clone(),
            runtime_receipt_refs: evidence.runtime_receipt_refs.clone(),
            validation_refs: evidence.validation_refs.clone(),
            review_refs: evidence.review_refs.clone(),
            change_request_prep_refs: evidence.change_request_prep_refs.clone(),
            repair_refs: evidence.repair_refs.clone(),
        }
    }
}

impl From<&SelectedTaskScmHandoffNextStep> for ControlSelectedTaskScmHandoffNextStepDto {
    fn from(next: &SelectedTaskScmHandoffNextStep) -> Self {
        Self {
            category: next_category_label(next.category).to_owned(),
            summary: next.summary.clone(),
            next_ref: next.next_ref.clone(),
            rationale_refs: next.rationale_refs.clone(),
        }
    }
}

impl From<&SelectedTaskScmHandoffSourceCounts> for ControlSelectedTaskScmHandoffSourceCountsDto {
    fn from(counts: &SelectedTaskScmHandoffSourceCounts) -> Self {
        Self {
            task_records: counts.task_records,
            work_items: counts.work_items,
            scm_handoff_refs: counts.scm_handoff_refs,
            scm_work_session_refs: counts.scm_work_session_refs,
            provider_change_refs: counts.provider_change_refs,
            checkpoint_refs: counts.checkpoint_refs,
            diff_summary_refs: counts.diff_summary_refs,
            runtime_receipt_refs: counts.runtime_receipt_refs,
            validation_refs: counts.validation_refs,
            review_refs: counts.review_refs,
            change_request_prep_refs: counts.change_request_prep_refs,
            repair_refs: counts.repair_refs,
            gap_count: counts.gap_count,
        }
    }
}

impl From<&SelectedTaskScmHandoffGap> for ControlSelectedTaskScmHandoffGapDto {
    fn from(gap: &SelectedTaskScmHandoffGap) -> Self {
        Self {
            area: gap_area_label(gap.area).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}

impl From<&SelectedTaskScmHandoffNoEffects> for ControlSelectedTaskScmHandoffNoEffectsDto {
    fn from(no_effects: &SelectedTaskScmHandoffNoEffects) -> Self {
        Self {
            scm_mutation_performed: no_effects.scm_mutation_performed,
            forge_mutation_performed: no_effects.forge_mutation_performed,
            credential_resolution_performed: no_effects.credential_resolution_performed,
            task_mutation_performed: no_effects.task_mutation_performed,
            provider_execution_performed: no_effects.provider_execution_performed,
            review_mutation_performed: no_effects.review_mutation_performed,
            accepted_memory_apply_performed: no_effects.accepted_memory_apply_performed,
            planning_apply_performed: no_effects.planning_apply_performed,
            projection_write_performed: no_effects.projection_write_performed,
            ui_effect_performed: no_effects.ui_effect_performed,
        }
    }
}

fn readiness_state_label(state: SelectedTaskScmHandoffState) -> &'static str {
    match state {
        SelectedTaskScmHandoffState::Missing => "missing",
        SelectedTaskScmHandoffState::Blocked => "blocked",
        SelectedTaskScmHandoffState::EvidenceReady => "evidence_ready",
        SelectedTaskScmHandoffState::PrepReady => "prep_ready",
        SelectedTaskScmHandoffState::PublicationPending => "publication_pending",
        SelectedTaskScmHandoffState::Represented => "represented",
        SelectedTaskScmHandoffState::RepairRequired => "repair_required",
    }
}

fn target_shape_label(shape: SelectedTaskScmHandoffTargetShape) -> &'static str {
    match shape {
        SelectedTaskScmHandoffTargetShape::ForgeReview => "forge_review",
        SelectedTaskScmHandoffTargetShape::ProviderPublication => "provider_publication",
        SelectedTaskScmHandoffTargetShape::ProviderGate => "provider_gate",
        SelectedTaskScmHandoffTargetShape::DirectAuthorityUpdate => "direct_authority_update",
        SelectedTaskScmHandoffTargetShape::ManualHandoff => "manual_handoff",
        SelectedTaskScmHandoffTargetShape::CustomProviderValue => "custom_provider_value",
        SelectedTaskScmHandoffTargetShape::Unknown => "unknown",
    }
}

fn next_category_label(category: SelectedTaskScmHandoffNextCategory) -> &'static str {
    match category {
        SelectedTaskScmHandoffNextCategory::InspectEvidence => "inspect_evidence",
        SelectedTaskScmHandoffNextCategory::PrepareChangeRequest => "prepare_change_request",
        SelectedTaskScmHandoffNextCategory::ReviewPreparation => "review_preparation",
        SelectedTaskScmHandoffNextCategory::PublishHandoff => "publish_handoff",
        SelectedTaskScmHandoffNextCategory::Repair => "repair",
        SelectedTaskScmHandoffNextCategory::Wait => "wait",
        SelectedTaskScmHandoffNextCategory::PlanningAmbiguity => "planning_ambiguity",
    }
}

fn gap_area_label(area: SelectedTaskScmHandoffGapArea) -> &'static str {
    match area {
        SelectedTaskScmHandoffGapArea::Task => "task",
        SelectedTaskScmHandoffGapArea::WorkProgress => "work_progress",
        SelectedTaskScmHandoffGapArea::ScmHandoff => "scm_handoff",
        SelectedTaskScmHandoffGapArea::WorkSession => "work_session",
        SelectedTaskScmHandoffGapArea::ProviderChange => "provider_change",
        SelectedTaskScmHandoffGapArea::Checkpoint => "checkpoint",
        SelectedTaskScmHandoffGapArea::Diff => "diff",
        SelectedTaskScmHandoffGapArea::RuntimeReceipt => "runtime_receipt",
        SelectedTaskScmHandoffGapArea::Validation => "validation",
        SelectedTaskScmHandoffGapArea::Review => "review",
        SelectedTaskScmHandoffGapArea::ChangeRequestPrep => "change_request_prep",
        SelectedTaskScmHandoffGapArea::Target => "target",
    }
}
