//! Read-only diagnostics for completion-to-change-request readiness.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmPromotionCandidatesRecord, CompletionScmProviderNeutralMappingRecord,
    CompletionScmProviderNeutralReadinessStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionChangeRequestReadinessDiagnosticsInput {
    pub candidates: CompletionScmPromotionCandidatesRecord,
    pub mapping: CompletionScmProviderNeutralMappingRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionChangeRequestReadinessDiagnosticsRecord {
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub skipped_candidate_count: usize,
    pub readiness_count: usize,
    pub ready_count: usize,
    pub unsupported_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub scm_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn completion_change_request_readiness_diagnostics(
    input: CompletionChangeRequestReadinessDiagnosticsInput,
) -> CompletionChangeRequestReadinessDiagnosticsRecord {
    let ready_count = input
        .mapping
        .readiness
        .iter()
        .filter(|readiness| readiness.status == CompletionScmProviderNeutralReadinessStatus::Ready)
        .count();
    let unsupported_count = input
        .mapping
        .readiness
        .iter()
        .filter(|readiness| {
            readiness.status == CompletionScmProviderNeutralReadinessStatus::Unsupported
        })
        .count();
    let repair_required_count = input
        .mapping
        .readiness
        .iter()
        .filter(|readiness| {
            readiness.status == CompletionScmProviderNeutralReadinessStatus::RepairRequired
        })
        .count();
    let blocker_count = input
        .mapping
        .readiness
        .iter()
        .map(|readiness| readiness.blockers.len())
        .sum();

    CompletionChangeRequestReadinessDiagnosticsRecord {
        diagnostics_id: "completion-change-request-readiness-diagnostics".to_owned(),
        candidate_count: input.candidates.candidates.len(),
        skipped_candidate_count: input.candidates.skipped_history_entry_ids.len()
            + input.mapping.skipped_candidate_ids.len(),
        readiness_count: input.mapping.readiness.len(),
        ready_count,
        unsupported_count,
        repair_required_count,
        blocker_count,
        scm_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CompletionScmProviderNeutralReadinessBlocker;

    #[test]
    fn completion_change_request_readiness_diagnostics_summarize_readiness_state() {
        let diagnostics = completion_change_request_readiness_diagnostics(input());

        assert_eq!(diagnostics.candidate_count, 3);
        assert_eq!(diagnostics.skipped_candidate_count, 2);
        assert_eq!(diagnostics.readiness_count, 3);
        assert_eq!(diagnostics.ready_count, 1);
        assert_eq!(diagnostics.unsupported_count, 1);
        assert_eq!(diagnostics.repair_required_count, 1);
        assert_eq!(diagnostics.blocker_count, 2);
        assert!(!diagnostics.scm_authority_granted);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn input() -> CompletionChangeRequestReadinessDiagnosticsInput {
        CompletionChangeRequestReadinessDiagnosticsInput {
            candidates: crate::CompletionScmPromotionCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: (0..3)
                    .map(|index| crate::CompletionScmPromotionCandidate {
                        candidate_id: format!("candidate:{index}"),
                        history_entry_id: format!("history:{index}"),
                        task_id: "task:1".to_owned(),
                        work_item_id: format!("work:{index}"),
                        completion_id: format!("completion:{index}"),
                        operator_ref: "operator:tom".to_owned(),
                        evidence_refs: vec!["evidence:completion".to_owned()],
                    })
                    .collect(),
                skipped_history_entry_ids: vec!["history:skipped".to_owned()],
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            mapping: crate::CompletionScmProviderNeutralMappingRecord {
                mapping_id: "mapping".to_owned(),
                readiness: vec![
                    readiness(
                        "ready",
                        CompletionScmProviderNeutralReadinessStatus::Ready,
                        vec![],
                    ),
                    readiness(
                        "unsupported",
                        CompletionScmProviderNeutralReadinessStatus::Unsupported,
                        vec![
                            CompletionScmProviderNeutralReadinessBlocker::ChangeRequestUnsupported,
                        ],
                    ),
                    readiness(
                        "repair",
                        CompletionScmProviderNeutralReadinessStatus::RepairRequired,
                        vec![CompletionScmProviderNeutralReadinessBlocker::AdapterUnavailable],
                    ),
                ],
                skipped_candidate_ids: vec!["candidate:skipped".to_owned()],
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
        }
    }

    fn readiness(
        id: &str,
        status: CompletionScmProviderNeutralReadinessStatus,
        blockers: Vec<CompletionScmProviderNeutralReadinessBlocker>,
    ) -> crate::CompletionScmProviderNeutralReadiness {
        crate::CompletionScmProviderNeutralReadiness {
            readiness_id: format!("readiness:{id}"),
            candidate_id: format!("candidate:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: format!("work:{id}"),
            completion_id: format!("completion:{id}"),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
            adapter_label: "adapter".to_owned(),
            workflow_label: "workflow".to_owned(),
            status,
            blockers,
        }
    }
}
