//! Control DTOs for completion SCM capture-admission diagnostics.

use serde::{Deserialize, Serialize};

use crate::CompletionScmCaptureAdmissionDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCaptureControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub external_effect_blocker_count: usize,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_change_request_created: bool,
    pub forge_merge_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_material_exposed: bool,
}

pub fn completion_scm_capture_control_dto(
    diagnostics: CompletionScmCaptureAdmissionDiagnosticsRecord,
) -> CompletionScmCaptureControlDto {
    CompletionScmCaptureControlDto {
        dto_id: "completion-scm-capture-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        admission_count: diagnostics.admission_count,
        admitted_count: diagnostics.admitted_count,
        blocked_count: diagnostics.blocked_count,
        blocker_count: diagnostics.blocker_count,
        external_effect_blocker_count: diagnostics.external_effect_blocker_count,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_control_dto_serializes_sanitized_counts() {
        let dto = completion_scm_capture_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: CompletionScmCaptureControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.admission_count, 2);
        assert_eq!(decoded.admitted_count, 1);
        assert_eq!(decoded.blocked_count, 1);
        assert_eq!(decoded.external_effect_blocker_count, 1);
        assert!(!decoded.scm_capture_executed);
        assert!(!decoded.raw_material_exposed);
        assert!(!json.contains("raw_provider"));
        assert!(!json.contains("live_handle"));
    }

    fn diagnostics() -> CompletionScmCaptureAdmissionDiagnosticsRecord {
        CompletionScmCaptureAdmissionDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            admission_count: 2,
            admitted_count: 1,
            blocked_count: 1,
            blocker_count: 1,
            external_effect_blocker_count: 1,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_change_request_created: false,
            forge_merge_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_material_exposed: false,
        }
    }
}
