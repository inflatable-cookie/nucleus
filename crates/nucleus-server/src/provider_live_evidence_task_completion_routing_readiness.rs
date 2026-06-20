//! Diagnostics routing readiness for live evidence completion read models.

use serde::{Deserialize, Serialize};

use crate::LiveEvidenceCompletionReadModelRecord;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionDiagnosticsRoutingInput {
    pub read_model: Option<LiveEvidenceCompletionReadModelRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionDiagnosticsRoutingRecord {
    pub routing_id: String,
    pub domain: String,
    pub status: LiveEvidenceCompletionDiagnosticsRoutingStatus,
    pub diagnostics_id: Option<String>,
    pub repair_required: bool,
    pub client_mutation_authority: bool,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceCompletionDiagnosticsRoutingStatus {
    Ready,
    Deferred,
}

pub fn live_evidence_completion_diagnostics_routing(
    input: LiveEvidenceCompletionDiagnosticsRoutingInput,
) -> LiveEvidenceCompletionDiagnosticsRoutingRecord {
    match input.read_model {
        Some(read_model) => LiveEvidenceCompletionDiagnosticsRoutingRecord {
            routing_id: "live-evidence-completion-diagnostics-routing".to_owned(),
            domain: "live_evidence_completion".to_owned(),
            status: LiveEvidenceCompletionDiagnosticsRoutingStatus::Ready,
            diagnostics_id: Some(read_model.diagnostics.diagnostics_id),
            repair_required: !read_model
                .progress
                .repair_required_completion_ids
                .is_empty(),
            client_mutation_authority: false,
            provider_authority_granted: false,
            scm_authority_granted: false,
        },
        None => LiveEvidenceCompletionDiagnosticsRoutingRecord {
            routing_id: "live-evidence-completion-diagnostics-routing".to_owned(),
            domain: "live_evidence_completion".to_owned(),
            status: LiveEvidenceCompletionDiagnosticsRoutingStatus::Deferred,
            diagnostics_id: None,
            repair_required: true,
            client_mutation_authority: false,
            provider_authority_granted: false,
            scm_authority_granted: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_completion_diagnostics_routing_names_completion_domain() {
        let routing = live_evidence_completion_diagnostics_routing(
            LiveEvidenceCompletionDiagnosticsRoutingInput {
                read_model: Some(read_model(false)),
            },
        );

        assert_eq!(routing.domain, "live_evidence_completion");
        assert_eq!(
            routing.status,
            LiveEvidenceCompletionDiagnosticsRoutingStatus::Ready
        );
        assert_eq!(routing.diagnostics_id, Some("diagnostics:1".to_owned()));
        assert!(!routing.client_mutation_authority);
    }

    #[test]
    fn live_evidence_completion_diagnostics_routing_defers_missing_state_as_repair() {
        let routing = live_evidence_completion_diagnostics_routing(
            LiveEvidenceCompletionDiagnosticsRoutingInput { read_model: None },
        );

        assert_eq!(
            routing.status,
            LiveEvidenceCompletionDiagnosticsRoutingStatus::Deferred
        );
        assert!(routing.repair_required);
        assert!(routing.diagnostics_id.is_none());
    }

    fn read_model(repair_required: bool) -> LiveEvidenceCompletionReadModelRecord {
        crate::LiveEvidenceCompletionReadModelRecord {
            read_model_id: "read-model:1".to_owned(),
            source_completion_count: 1,
            timeline: crate::LiveEvidenceCompletionTimelineProjectionRecord {
                projection_id: "timeline".to_owned(),
                entries: Vec::new(),
                skipped_completion_ids: Vec::new(),
                provider_authority_granted: false,
                scm_authority_granted: false,
                client_mutation_authority: false,
                raw_provider_material_exposed: false,
            },
            progress: crate::LiveEvidenceCompletionProgressProjectionRecord {
                projection_id: "progress".to_owned(),
                completed_work_items: Vec::new(),
                skipped_completion_ids: Vec::new(),
                repair_required_completion_ids: if repair_required {
                    vec!["completion:repair".to_owned()]
                } else {
                    Vec::new()
                },
                client_mutation_authority: false,
                provider_authority_granted: false,
                scm_authority_granted: false,
                raw_provider_material_exposed: false,
            },
            diagnostics: crate::LiveEvidenceCompletionReadModelDiagnosticsRecord {
                diagnostics_id: "diagnostics:1".to_owned(),
                timeline_entry_count: 0,
                timeline_skipped_completion_count: 0,
                completed_work_item_count: 0,
                progress_skipped_completion_count: 0,
                repair_required_completion_count: usize::from(repair_required),
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
