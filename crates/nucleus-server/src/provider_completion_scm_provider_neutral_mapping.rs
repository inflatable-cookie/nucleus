//! Provider-neutral SCM readiness mapping for completion promotion candidates.

use serde::{Deserialize, Serialize};

use crate::CompletionScmPromotionCandidatesRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmProviderNeutralMappingInput {
    pub candidates: CompletionScmPromotionCandidatesRecord,
    pub adapter_label: String,
    pub workflow_label: String,
    pub adapter_supports_change_requests: bool,
    pub adapter_available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmProviderNeutralMappingRecord {
    pub mapping_id: String,
    pub readiness: Vec<CompletionScmProviderNeutralReadiness>,
    pub skipped_candidate_ids: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub scm_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmProviderNeutralReadiness {
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub status: CompletionScmProviderNeutralReadinessStatus,
    pub blockers: Vec<CompletionScmProviderNeutralReadinessBlocker>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmProviderNeutralReadinessStatus {
    Ready,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmProviderNeutralReadinessBlocker {
    AdapterUnavailable,
    ChangeRequestUnsupported,
    AdapterLabelMissing,
    WorkflowLabelMissing,
}

pub fn completion_scm_provider_neutral_mapping(
    input: CompletionScmProviderNeutralMappingInput,
) -> CompletionScmProviderNeutralMappingRecord {
    let readiness_blockers = blockers(&input);
    let readiness_status = status(&readiness_blockers);
    let mut readiness = input
        .candidates
        .candidates
        .into_iter()
        .map(|candidate| CompletionScmProviderNeutralReadiness {
            readiness_id: format!("completion-scm-readiness:{}", candidate.candidate_id),
            candidate_id: candidate.candidate_id,
            task_id: candidate.task_id,
            work_item_id: candidate.work_item_id,
            completion_id: candidate.completion_id,
            operator_ref: candidate.operator_ref,
            evidence_refs: candidate.evidence_refs,
            adapter_label: input.adapter_label.clone(),
            workflow_label: input.workflow_label.clone(),
            status: readiness_status.clone(),
            blockers: readiness_blockers.clone(),
        })
        .collect::<Vec<_>>();
    readiness.sort_by(|left, right| left.readiness_id.cmp(&right.readiness_id));

    CompletionScmProviderNeutralMappingRecord {
        mapping_id: "completion-scm-provider-neutral-mapping".to_owned(),
        readiness,
        skipped_candidate_ids: input.candidates.skipped_history_entry_ids,
        adapter_label: input.adapter_label,
        workflow_label: input.workflow_label,
        scm_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn blockers(
    input: &CompletionScmProviderNeutralMappingInput,
) -> Vec<CompletionScmProviderNeutralReadinessBlocker> {
    let mut blockers = Vec::new();
    if !input.adapter_available {
        blockers.push(CompletionScmProviderNeutralReadinessBlocker::AdapterUnavailable);
    }
    if !input.adapter_supports_change_requests {
        blockers.push(CompletionScmProviderNeutralReadinessBlocker::ChangeRequestUnsupported);
    }
    if input.adapter_label.trim().is_empty() {
        blockers.push(CompletionScmProviderNeutralReadinessBlocker::AdapterLabelMissing);
    }
    if input.workflow_label.trim().is_empty() {
        blockers.push(CompletionScmProviderNeutralReadinessBlocker::WorkflowLabelMissing);
    }
    blockers
}

fn status(
    blockers: &[CompletionScmProviderNeutralReadinessBlocker],
) -> CompletionScmProviderNeutralReadinessStatus {
    if blockers.is_empty() {
        CompletionScmProviderNeutralReadinessStatus::Ready
    } else if blockers
        .iter()
        .any(|blocker| blocker == &CompletionScmProviderNeutralReadinessBlocker::AdapterUnavailable)
    {
        CompletionScmProviderNeutralReadinessStatus::RepairRequired
    } else {
        CompletionScmProviderNeutralReadinessStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_provider_neutral_mapping_keeps_core_terms_provider_neutral() {
        let record = completion_scm_provider_neutral_mapping(input(
            "git",
            "branch-and-review-request",
            true,
            true,
        ));

        assert_eq!(record.readiness.len(), 1);
        assert_eq!(
            record.readiness[0].status,
            CompletionScmProviderNeutralReadinessStatus::Ready
        );
        assert_eq!(record.readiness[0].adapter_label, "git");
        assert_eq!(
            record.readiness[0].workflow_label,
            "branch-and-review-request"
        );
        assert!(!record.scm_authority_granted);
    }

    #[test]
    fn completion_scm_provider_neutral_mapping_allows_non_git_workflow_labels() {
        let record = completion_scm_provider_neutral_mapping(input(
            "convergence",
            "snapshot-and-publish",
            true,
            true,
        ));

        assert_eq!(record.readiness[0].adapter_label, "convergence");
        assert_eq!(record.readiness[0].workflow_label, "snapshot-and-publish");
        assert_eq!(
            record.readiness[0].status,
            CompletionScmProviderNeutralReadinessStatus::Ready
        );
    }

    #[test]
    fn completion_scm_provider_neutral_mapping_surfaces_unsupported_or_repair_states() {
        let unsupported = completion_scm_provider_neutral_mapping(input(
            "plain-files",
            "manual-share",
            false,
            true,
        ));
        let repair = completion_scm_provider_neutral_mapping(input(
            "missing",
            "review-request",
            true,
            false,
        ));

        assert_eq!(
            unsupported.readiness[0].status,
            CompletionScmProviderNeutralReadinessStatus::Unsupported
        );
        assert_eq!(
            repair.readiness[0].status,
            CompletionScmProviderNeutralReadinessStatus::RepairRequired
        );
        assert!(!unsupported.forge_authority_granted);
        assert!(!repair.raw_material_exposed);
    }

    fn input(
        adapter_label: &str,
        workflow_label: &str,
        adapter_supports_change_requests: bool,
        adapter_available: bool,
    ) -> CompletionScmProviderNeutralMappingInput {
        CompletionScmProviderNeutralMappingInput {
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
            adapter_label: adapter_label.to_owned(),
            workflow_label: workflow_label.to_owned(),
            adapter_supports_change_requests,
            adapter_available,
        }
    }
}
