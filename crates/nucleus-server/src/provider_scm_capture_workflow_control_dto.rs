//! Control DTOs for SCM capture workflow diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureWorkflowDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureWorkflowControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub workflow_count: usize,
    pub ready_for_operator_review_count: usize,
    pub missing_stage_count: usize,
    pub completed_stage_count: usize,
    pub blocked_stage_count: usize,
    pub repair_required_stage_count: usize,
    pub evidence_ref_count: usize,
    pub replay_only: bool,
    pub raw_output_retained: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
}

pub fn scm_capture_workflow_control_dto(
    diagnostics: ScmCaptureWorkflowDiagnosticsRecord,
) -> ScmCaptureWorkflowControlDto {
    ScmCaptureWorkflowControlDto {
        dto_id: "scm-capture-workflow-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        workflow_count: diagnostics.workflow_count,
        ready_for_operator_review_count: diagnostics.ready_for_operator_review_count,
        missing_stage_count: diagnostics.missing_stage_count,
        completed_stage_count: diagnostics.completed_stage_count,
        blocked_stage_count: diagnostics.blocked_stage_count,
        repair_required_stage_count: diagnostics.repair_required_stage_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        replay_only: true,
        raw_output_retained: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_workflow_control_dto_serializes_sanitized_counts() {
        let dto = scm_capture_workflow_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmCaptureWorkflowControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.workflow_count, 2);
        assert_eq!(decoded.completed_stage_count, 5);
        assert_eq!(decoded.evidence_ref_count, 3);
        assert!(decoded.replay_only);
        assert!(!decoded.scm_mutation_authority_granted);
        assert!(!decoded.provider_authority_granted);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> ScmCaptureWorkflowDiagnosticsRecord {
        ScmCaptureWorkflowDiagnosticsRecord {
            diagnostics_id: "diagnostics:workflow".to_owned(),
            workflow_count: 2,
            ready_for_operator_review_count: 1,
            missing_stage_count: 1,
            completed_stage_count: 5,
            blocked_stage_count: 1,
            repair_required_stage_count: 0,
            evidence_ref_count: 3,
            replay_only: true,
            raw_output_retained: false,
            scm_mutation_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
        }
    }
}
