//! Authority proof for completion-to-SCM readiness surfaces.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionChangeRequestReadinessDiagnosticsRecord, CompletionScmPromotionCandidatesRecord,
    CompletionScmProviderNeutralMappingRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmAuthorityInput {
    pub candidates: CompletionScmPromotionCandidatesRecord,
    pub mapping: CompletionScmProviderNeutralMappingRecord,
    pub diagnostics: CompletionChangeRequestReadinessDiagnosticsRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmAuthorityRecord {
    pub authority_id: String,
    pub candidate_count: usize,
    pub readiness_count: usize,
    pub ready_count: usize,
    pub scm_capture_started: bool,
    pub scm_share_started: bool,
    pub scm_publish_started: bool,
    pub forge_change_request_started: bool,
    pub forge_merge_started: bool,
    pub provider_write_started: bool,
    pub callback_response_started: bool,
    pub interruption_started: bool,
    pub recovery_started: bool,
    pub raw_material_exposed: bool,
}

pub fn completion_scm_authority(
    input: CompletionScmAuthorityInput,
) -> CompletionScmAuthorityRecord {
    CompletionScmAuthorityRecord {
        authority_id: "completion-scm-authority".to_owned(),
        candidate_count: input.candidates.candidates.len(),
        readiness_count: input.mapping.readiness.len(),
        ready_count: input.diagnostics.ready_count,
        scm_capture_started: false,
        scm_share_started: false,
        scm_publish_started: false,
        forge_change_request_started: false,
        forge_merge_started: false,
        provider_write_started: false,
        callback_response_started: false,
        interruption_started: false,
        recovery_started: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_authority_does_not_execute_scm_forge_or_provider_effects() {
        let record = completion_scm_authority(input());

        assert_eq!(record.candidate_count, 1);
        assert_eq!(record.readiness_count, 1);
        assert_eq!(record.ready_count, 1);
        assert!(!record.scm_capture_started);
        assert!(!record.scm_share_started);
        assert!(!record.scm_publish_started);
        assert!(!record.forge_change_request_started);
        assert!(!record.forge_merge_started);
        assert!(!record.provider_write_started);
        assert!(!record.callback_response_started);
        assert!(!record.interruption_started);
        assert!(!record.recovery_started);
        assert!(!record.raw_material_exposed);
    }

    fn input() -> CompletionScmAuthorityInput {
        CompletionScmAuthorityInput {
            candidates: crate::CompletionScmPromotionCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: vec![crate::CompletionScmPromotionCandidate {
                    candidate_id: "candidate:1".to_owned(),
                    history_entry_id: "history:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:completion".to_owned()],
                }],
                skipped_history_entry_ids: Vec::new(),
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            mapping: crate::CompletionScmProviderNeutralMappingRecord {
                mapping_id: "mapping".to_owned(),
                readiness: vec![crate::CompletionScmProviderNeutralReadiness {
                    readiness_id: "readiness:1".to_owned(),
                    candidate_id: "candidate:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:completion".to_owned()],
                    adapter_label: "adapter".to_owned(),
                    workflow_label: "workflow".to_owned(),
                    status: crate::CompletionScmProviderNeutralReadinessStatus::Ready,
                    blockers: Vec::new(),
                }],
                skipped_candidate_ids: Vec::new(),
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            diagnostics: crate::CompletionChangeRequestReadinessDiagnosticsRecord {
                diagnostics_id: "diagnostics".to_owned(),
                candidate_count: 1,
                skipped_candidate_count: 0,
                readiness_count: 1,
                ready_count: 1,
                unsupported_count: 0,
                repair_required_count: 0,
                blocker_count: 0,
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }
}
