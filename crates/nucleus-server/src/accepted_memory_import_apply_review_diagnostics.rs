//! Read-only diagnostics for accepted-memory import-apply review receipts.
//!
//! This model synthesizes sanitized review-command validation receipts from
//! stopped apply/admission diagnostics. It does not persist receipts or grant
//! active apply authority.

use crate::provider_no_effects::{MemoryApplyNoEffects};
use nucleus_projects::ProjectId;

use crate::accepted_memory_import_apply_review_command::{
    accepted_memory_import_apply_review_receipts, AcceptedMemoryImportApplyReviewDecision,
    AcceptedMemoryImportApplyReviewInput, AcceptedMemoryImportApplyReviewSet,
};
use crate::accepted_memory_projection_import_apply_admission::AcceptedMemoryProjectionImportApplyAdmissionRecord;
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryImportApplyReviewDiagnostics {
    pub diagnostics_id: String,
    pub project_id: ProjectId,
    pub review_set: AcceptedMemoryImportApplyReviewSet,
    pub review_receipts_persisted: bool,
    pub no_effects: MemoryApplyNoEffects,
}

impl AcceptedMemoryImportApplyReviewDiagnostics {
    pub fn from_apply_diagnostics(
        project_id: ProjectId,
        apply: AcceptedMemoryProjectionImportApplyDiagnostics,
    ) -> Self {
        let inputs = apply
            .records
            .into_iter()
            .flat_map(review_inputs_for_admission)
            .collect::<Vec<_>>();
        let review_set = accepted_memory_import_apply_review_receipts(inputs);

        Self {
            diagnostics_id: "accepted-memory-import-apply-review-diagnostics".to_owned(),
            project_id,
            review_set,
            review_receipts_persisted: false,
        no_effects: MemoryApplyNoEffects::none(),
        }
    }
}

fn review_inputs_for_admission(
    admission: AcceptedMemoryProjectionImportApplyAdmissionRecord,
) -> Vec<AcceptedMemoryImportApplyReviewInput> {
    [
        AcceptedMemoryImportApplyReviewDecision::Approve,
        AcceptedMemoryImportApplyReviewDecision::Defer,
        AcceptedMemoryImportApplyReviewDecision::Reject,
    ]
    .into_iter()
    .map(|decision| review_input(admission.clone(), decision))
    .collect()
}

fn review_input(
    admission: AcceptedMemoryProjectionImportApplyAdmissionRecord,
    decision: AcceptedMemoryImportApplyReviewDecision,
) -> AcceptedMemoryImportApplyReviewInput {
    let decision_key = review_decision_key(&decision);
    let apply_ref = admission.apply_admission_ref.clone();

    AcceptedMemoryImportApplyReviewInput {
        command_id: format!(
            "command:accepted-memory-import-apply-review:{apply_ref}:{decision_key}"
        ),
        operator_ref: "operator:diagnostics".to_owned(),
        approval_ref: match decision {
            AcceptedMemoryImportApplyReviewDecision::Approve => {
                format!("approval:accepted-memory-import-apply-review:{apply_ref}")
            }
            AcceptedMemoryImportApplyReviewDecision::Defer
            | AcceptedMemoryImportApplyReviewDecision::Reject => String::new(),
        },
        decision_reason_ref: match decision {
            AcceptedMemoryImportApplyReviewDecision::Approve => String::new(),
            AcceptedMemoryImportApplyReviewDecision::Defer
            | AcceptedMemoryImportApplyReviewDecision::Reject => {
                format!(
                    "decision-reason:accepted-memory-import-apply-review:{apply_ref}:{decision_key}"
                )
            }
        },
        decision,
        provenance_refs: admission.provenance_refs.clone(),
        evidence_refs: admission.evidence_refs.clone(),
        admission,
        raw_payload_present: false,
        active_memory_mutation_requested: false,
        projection_write_requested: false,
        scm_effect_requested: false,
        embedding_requested: false,
        provider_sync_requested: false,
        automatic_extraction_requested: false,
        task_mutation_requested: false,
        agent_scheduling_requested: false,
        ui_effect_requested: false,
    }
}

fn review_decision_key(decision: &AcceptedMemoryImportApplyReviewDecision) -> &'static str {
    match decision {
        AcceptedMemoryImportApplyReviewDecision::Approve => "approve",
        AcceptedMemoryImportApplyReviewDecision::Defer => "defer",
        AcceptedMemoryImportApplyReviewDecision::Reject => "reject",
    }
}
