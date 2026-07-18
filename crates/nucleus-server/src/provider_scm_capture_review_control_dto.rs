//! Control DTOs for SCM capture operator review readiness diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureReviewDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ScmCaptureReviewControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub readiness_count: usize,
    #[ts(as = "u32")]
    pub ready_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    pub operator_decision_created: bool,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn scm_capture_review_control_dto(
    diagnostics: ScmCaptureReviewDiagnosticsRecord,
) -> ScmCaptureReviewControlDto {
    ScmCaptureReviewControlDto {
        dto_id: "scm-capture-review-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        readiness_count: diagnostics.readiness_count,
        ready_count: diagnostics.ready_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        blocker_count: diagnostics.blocker_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        operator_decision_created: false,
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_review_control_dto_serializes_sanitized_counts() {
        let dto = scm_capture_review_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmCaptureReviewControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.readiness_count, 3);
        assert_eq!(decoded.ready_count, 1);
        assert_eq!(decoded.blocked_count, 1);
        assert_eq!(decoded.repair_required_count, 1);
        assert_eq!(decoded.blocker_count, 2);
        assert_eq!(decoded.evidence_ref_count, 4);
        assert!(!decoded.operator_decision_created);
        assert!(!decoded.change_request_authority_granted);
        assert!(!decoded.scm_mutation_authority_granted);
        assert!(!decoded.provider_authority_granted);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> ScmCaptureReviewDiagnosticsRecord {
        ScmCaptureReviewDiagnosticsRecord {
            diagnostics_id: "diagnostics:review".to_owned(),
            readiness_count: 3,
            ready_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            blocker_count: 2,
            evidence_ref_count: 4,
            change_request_authority_granted: false,
            scm_mutation_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            raw_output_retained: false,
        }
    }
}
