//! Read model for completion-to-SCM readiness control surfaces.

use serde::{Deserialize, Serialize};

use crate::{
    completion_change_request_readiness_diagnostics, completion_scm_authority,
    completion_scm_promotion_candidates, completion_scm_provider_neutral_mapping,
    CompletionChangeRequestReadinessDiagnosticsInput,
    CompletionChangeRequestReadinessDiagnosticsRecord, CompletionScmAuthorityInput,
    CompletionScmAuthorityRecord, CompletionScmPromotionCandidatesInput,
    CompletionScmPromotionCandidatesRecord, CompletionScmProviderNeutralMappingInput,
    CompletionScmProviderNeutralMappingRecord, LiveEvidenceTaskStateHistoryProjectionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmReadModelInput {
    pub history: Option<LiveEvidenceTaskStateHistoryProjectionRecord>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub adapter_supports_change_requests: bool,
    pub adapter_available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmReadModelRecord {
    pub read_model_id: String,
    pub source_history_available: bool,
    pub candidates: CompletionScmPromotionCandidatesRecord,
    pub mapping: CompletionScmProviderNeutralMappingRecord,
    pub diagnostics: CompletionChangeRequestReadinessDiagnosticsRecord,
    pub authority: CompletionScmAuthorityRecord,
    pub scm_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn completion_scm_read_model(
    input: CompletionScmReadModelInput,
) -> CompletionScmReadModelRecord {
    let source_history_available = input.history.is_some();
    let history = input.history.unwrap_or_else(empty_history);
    let candidates =
        completion_scm_promotion_candidates(CompletionScmPromotionCandidatesInput { history });
    let mapping =
        completion_scm_provider_neutral_mapping(CompletionScmProviderNeutralMappingInput {
            candidates: candidates.clone(),
            adapter_label: input.adapter_label,
            workflow_label: input.workflow_label,
            adapter_supports_change_requests: input.adapter_supports_change_requests,
            adapter_available: input.adapter_available,
        });
    let diagnostics = completion_change_request_readiness_diagnostics(
        CompletionChangeRequestReadinessDiagnosticsInput {
            candidates: candidates.clone(),
            mapping: mapping.clone(),
        },
    );
    let authority = completion_scm_authority(CompletionScmAuthorityInput {
        candidates: candidates.clone(),
        mapping: mapping.clone(),
        diagnostics: diagnostics.clone(),
    });

    CompletionScmReadModelRecord {
        read_model_id: "completion-scm-read-model".to_owned(),
        source_history_available,
        candidates,
        mapping,
        diagnostics,
        authority,
        scm_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn empty_history() -> LiveEvidenceTaskStateHistoryProjectionRecord {
    LiveEvidenceTaskStateHistoryProjectionRecord {
        projection_id: "completion-scm-missing-task-state-history".to_owned(),
        entries: Vec::new(),
        skipped_admission_ids: Vec::new(),
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_read_model_composes_readiness_surfaces() {
        let read_model = completion_scm_read_model(input(Some(history()), true, true));

        assert!(read_model.source_history_available);
        assert_eq!(read_model.candidates.candidates.len(), 1);
        assert_eq!(read_model.mapping.readiness.len(), 1);
        assert_eq!(read_model.diagnostics.ready_count, 1);
        assert_eq!(read_model.authority.ready_count, 1);
        assert!(!read_model.scm_authority_granted);
        assert!(!read_model.forge_authority_granted);
    }

    #[test]
    fn completion_scm_read_model_keeps_unsupported_and_missing_state_visible() {
        let missing = completion_scm_read_model(input(None, true, false));
        let unsupported = completion_scm_read_model(input(Some(history()), false, true));

        assert!(!missing.source_history_available);
        assert_eq!(missing.candidates.candidates.len(), 0);
        assert_eq!(unsupported.diagnostics.unsupported_count, 1);
        assert!(!unsupported.provider_authority_granted);
        assert!(!unsupported.raw_material_exposed);
    }

    fn input(
        history: Option<LiveEvidenceTaskStateHistoryProjectionRecord>,
        adapter_supports_change_requests: bool,
        adapter_available: bool,
    ) -> CompletionScmReadModelInput {
        CompletionScmReadModelInput {
            history,
            adapter_label: "git".to_owned(),
            workflow_label: "review-request".to_owned(),
            adapter_supports_change_requests,
            adapter_available,
        }
    }

    fn history() -> LiveEvidenceTaskStateHistoryProjectionRecord {
        LiveEvidenceTaskStateHistoryProjectionRecord {
            projection_id: "history".to_owned(),
            entries: vec![crate::LiveEvidenceTaskStateHistoryEntry {
                history_entry_id: "history:1".to_owned(),
                admission_id: "admission:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: "work:1".to_owned(),
                completion_id: "completion:1".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:completion".to_owned()],
                task_state: "completed".to_owned(),
            }],
            skipped_admission_ids: Vec::new(),
            provider_authority_granted: false,
            scm_authority_granted: false,
            raw_material_exposed: false,
        }
    }
}
