//! Authority regression for live evidence completion control read models.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceCompletionControlDto, LiveEvidenceCompletionDiagnosticsRoutingRecord,
    LiveEvidenceCompletionReadModelRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceCompletionControlAuthorityInput {
    pub read_model: LiveEvidenceCompletionReadModelRecord,
    pub dto: LiveEvidenceCompletionControlDto,
    pub routing: LiveEvidenceCompletionDiagnosticsRoutingRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceCompletionControlAuthorityRecord {
    pub authority_id: String,
    pub task_state_mutation_granted: bool,
    pub provider_write_granted: bool,
    pub callback_response_granted: bool,
    pub interruption_granted: bool,
    pub recovery_granted: bool,
    pub scm_mutation_granted: bool,
    pub diagnostics_execution_granted: bool,
}

pub fn live_evidence_completion_control_authority(
    _input: LiveEvidenceCompletionControlAuthorityInput,
) -> LiveEvidenceCompletionControlAuthorityRecord {
    LiveEvidenceCompletionControlAuthorityRecord {
        authority_id: "live-evidence-completion-control-authority".to_owned(),
        task_state_mutation_granted: false,
        provider_write_granted: false,
        callback_response_granted: false,
        interruption_granted: false,
        recovery_granted: false,
        scm_mutation_granted: false,
        diagnostics_execution_granted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_completion_control_authority_keeps_read_models_read_only() {
        let read_model = read_model();
        let dto = crate::live_evidence_completion_control_dto(read_model.clone());
        let routing = crate::live_evidence_completion_diagnostics_routing(
            crate::LiveEvidenceCompletionDiagnosticsRoutingInput {
                read_model: Some(read_model.clone()),
            },
        );

        let authority = live_evidence_completion_control_authority(
            LiveEvidenceCompletionControlAuthorityInput {
                read_model,
                dto,
                routing,
            },
        );

        assert!(!authority.task_state_mutation_granted);
        assert!(!authority.provider_write_granted);
        assert!(!authority.callback_response_granted);
        assert!(!authority.interruption_granted);
        assert!(!authority.recovery_granted);
        assert!(!authority.scm_mutation_granted);
        assert!(!authority.diagnostics_execution_granted);
    }

    fn read_model() -> LiveEvidenceCompletionReadModelRecord {
        crate::live_evidence_completion_read_model(crate::LiveEvidenceCompletionReadModelInput {
            completions: Vec::new(),
        })
    }
}
