//! Control DTOs for explicit live evidence completion projections.

use serde::{Deserialize, Serialize};

use crate::LiveEvidenceCompletionReadModelRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionControlDto {
    pub dto_id: String,
    pub read_model_id: String,
    pub timeline_entry_count: usize,
    pub completed_work_item_count: usize,
    pub skipped_completion_ids: Vec<String>,
    pub repair_required_completion_ids: Vec<String>,
    pub diagnostics_id: String,
    pub client_mutation_authority: bool,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_provider_material_exposed: bool,
}

pub fn live_evidence_completion_control_dto(
    read_model: LiveEvidenceCompletionReadModelRecord,
) -> LiveEvidenceCompletionControlDto {
    let mut skipped_completion_ids = read_model.timeline.skipped_completion_ids;
    skipped_completion_ids.extend(read_model.progress.skipped_completion_ids);
    skipped_completion_ids.sort();
    skipped_completion_ids.dedup();

    LiveEvidenceCompletionControlDto {
        dto_id: "live-evidence-completion-control-dto".to_owned(),
        read_model_id: read_model.read_model_id,
        timeline_entry_count: read_model.timeline.entries.len(),
        completed_work_item_count: read_model.progress.completed_work_items.len(),
        skipped_completion_ids,
        repair_required_completion_ids: read_model.progress.repair_required_completion_ids,
        diagnostics_id: read_model.diagnostics.diagnostics_id,
        client_mutation_authority: false,
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_provider_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_completion_control_dto_serializes_sanitized_projection_state() {
        let dto = live_evidence_completion_control_dto(read_model());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: LiveEvidenceCompletionControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.timeline_entry_count, 1);
        assert_eq!(decoded.completed_work_item_count, 1);
        assert_eq!(
            decoded.repair_required_completion_ids,
            vec!["completion:repair".to_owned()]
        );
        assert!(!json.contains("live_handle"));
        assert!(!decoded.client_mutation_authority);
    }

    fn read_model() -> LiveEvidenceCompletionReadModelRecord {
        crate::LiveEvidenceCompletionReadModelRecord {
            read_model_id: "read-model:1".to_owned(),
            source_completion_count: 2,
            timeline: crate::LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: vec![crate::LiveEvidenceCompletionTimelineEntry {
                    timeline_entry_id: "timeline:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    review_decision_id: "review:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:completion".to_owned()],
                    task_completed: true,
                }],
                skipped_completion_ids: vec!["completion:skipped".to_owned()],
                provider_authority_granted: false,
                scm_authority_granted: false,
                client_mutation_authority: false,
                raw_provider_material_exposed: false,
            },
            progress: crate::LiveEvidenceCompletionProgressProjectionRecord {
                projection_id: "progress".to_owned(),
                completed_work_items: vec![crate::LiveEvidenceCompletedWorkItemRecord {
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    review_decision_id: "review:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:completion".to_owned()],
                    completed: true,
                }],
                skipped_completion_ids: vec!["completion:skipped".to_owned()],
                repair_required_completion_ids: vec!["completion:repair".to_owned()],
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            diagnostics: crate::LiveEvidenceCompletionReadModelDiagnosticsRecord {
                diagnostics_id: "diagnostics:1".to_owned(),
                timeline_entry_count: 1,
                timeline_skipped_completion_count: 1,
                completed_work_item_count: 1,
                progress_skipped_completion_count: 1,
                repair_required_completion_count: 1,
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            client_mutation_authority: false,
            provider_authority_granted: false,
            scm_authority_granted: false,
            raw_provider_material_exposed: false,
        }
    }
}
