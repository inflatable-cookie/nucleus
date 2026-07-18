//! Control DTOs for completion-to-SCM readiness.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmProviderNeutralReadiness, CompletionScmProviderNeutralReadinessStatus,
    CompletionScmReadModelRecord,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CompletionScmControlDto {
    pub dto_id: String,
    pub read_model_id: String,
    pub source_history_available: bool,
    pub adapter_label: String,
    pub workflow_label: String,
    #[ts(as = "u32")]
    pub candidate_count: usize,
    #[ts(as = "u32")]
    pub readiness_count: usize,
    #[ts(as = "u32")]
    pub ready_count: usize,
    #[ts(as = "u32")]
    pub unsupported_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    pub repair_required: bool,
    pub readiness: Vec<CompletionScmReadinessDto>,
    pub scm_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CompletionScmReadinessDto {
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub completion_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: CompletionScmProviderNeutralReadinessStatus,
}

pub fn completion_scm_control_dto(
    read_model: CompletionScmReadModelRecord,
) -> CompletionScmControlDto {
    CompletionScmControlDto {
        dto_id: "completion-scm-control-dto".to_owned(),
        read_model_id: read_model.read_model_id,
        source_history_available: read_model.source_history_available,
        adapter_label: read_model.mapping.adapter_label,
        workflow_label: read_model.mapping.workflow_label,
        candidate_count: read_model.diagnostics.candidate_count,
        readiness_count: read_model.diagnostics.readiness_count,
        ready_count: read_model.diagnostics.ready_count,
        unsupported_count: read_model.diagnostics.unsupported_count,
        repair_required_count: read_model.diagnostics.repair_required_count,
        blocker_count: read_model.diagnostics.blocker_count,
        repair_required: !read_model.source_history_available
            || read_model.diagnostics.repair_required_count > 0,
        readiness: read_model
            .mapping
            .readiness
            .into_iter()
            .map(readiness_dto)
            .collect(),
        scm_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn readiness_dto(readiness: CompletionScmProviderNeutralReadiness) -> CompletionScmReadinessDto {
    CompletionScmReadinessDto {
        readiness_id: readiness.readiness_id,
        candidate_id: readiness.candidate_id,
        task_id: readiness.task_id,
        work_item_id: readiness.work_item_id,
        completion_id: readiness.completion_id,
        operator_ref: readiness.operator_ref,
        evidence_refs: readiness.evidence_refs,
        status: readiness.status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_control_dto_serializes_sanitized_readiness() {
        let dto = completion_scm_control_dto(crate::completion_scm_read_model(
            crate::CompletionScmReadModelInput {
                history: Some(history()),
                adapter_label: "convergence".to_owned(),
                workflow_label: "snapshot-and-publish".to_owned(),
                adapter_supports_change_requests: true,
                adapter_available: true,
            },
        ));
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: CompletionScmControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.candidate_count, 1);
        assert_eq!(decoded.readiness_count, 1);
        assert_eq!(decoded.adapter_label, "convergence");
        assert_eq!(decoded.workflow_label, "snapshot-and-publish");
        assert!(!decoded.repair_required);
        assert!(!decoded.scm_authority_granted);
        assert!(!json.contains("raw_provider"));
        assert!(!json.contains("live_handle"));
    }

    #[test]
    fn completion_scm_control_dto_marks_missing_state_as_repair_required() {
        let dto = completion_scm_control_dto(crate::completion_scm_read_model(
            crate::CompletionScmReadModelInput {
                history: None,
                adapter_label: "unconfigured".to_owned(),
                workflow_label: "none".to_owned(),
                adapter_supports_change_requests: false,
                adapter_available: false,
            },
        ));

        assert!(!dto.source_history_available);
        assert!(dto.repair_required);
        assert_eq!(dto.candidate_count, 0);
        assert!(!dto.provider_authority_granted);
    }

    fn history() -> crate::LiveEvidenceTaskStateHistoryProjectionRecord {
        crate::LiveEvidenceTaskStateHistoryProjectionRecord {
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
