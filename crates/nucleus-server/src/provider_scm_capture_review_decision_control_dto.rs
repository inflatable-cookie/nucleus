//! Control DTOs for SCM capture operator review-decision diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureReviewDecisionDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ScmCaptureReviewDecisionControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub decision_count: usize,
    #[ts(as = "u32")]
    pub persisted_decision_count: usize,
    #[ts(as = "u32")]
    pub duplicate_decision_count: usize,
    #[ts(as = "u32")]
    pub blocked_decision_count: usize,
    #[ts(as = "u32")]
    pub accepted_count: usize,
    #[ts(as = "u32")]
    pub rejected_count: usize,
    #[ts(as = "u32")]
    pub needs_changes_count: usize,
    #[ts(as = "u32")]
    pub abandoned_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    pub change_request_authority_granted: bool,
    pub scm_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn scm_capture_review_decision_control_dto(
    diagnostics: ScmCaptureReviewDecisionDiagnosticsRecord,
) -> ScmCaptureReviewDecisionControlDto {
    ScmCaptureReviewDecisionControlDto {
        dto_id: "scm-capture-review-decision-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        decision_count: diagnostics.decision_count,
        persisted_decision_count: diagnostics.persisted_decision_count,
        duplicate_decision_count: diagnostics.duplicate_decision_count,
        blocked_decision_count: diagnostics.blocked_decision_count,
        accepted_count: diagnostics.accepted_count,
        rejected_count: diagnostics.rejected_count,
        needs_changes_count: diagnostics.needs_changes_count,
        abandoned_count: diagnostics.abandoned_count,
        blocker_count: diagnostics.blocker_count,
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
    fn scm_capture_review_decision_control_dto_serializes_sanitized_counts() {
        let dto = scm_capture_review_decision_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmCaptureReviewDecisionControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.decision_count, 4);
        assert_eq!(decoded.persisted_decision_count, 2);
        assert_eq!(decoded.duplicate_decision_count, 1);
        assert_eq!(decoded.blocked_decision_count, 1);
        assert_eq!(decoded.accepted_count, 1);
        assert_eq!(decoded.rejected_count, 1);
        assert_eq!(decoded.needs_changes_count, 1);
        assert_eq!(decoded.abandoned_count, 1);
        assert_eq!(decoded.blocker_count, 2);
        assert!(!decoded.change_request_authority_granted);
        assert!(!decoded.scm_mutation_authority_granted);
        assert!(!decoded.provider_authority_granted);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> ScmCaptureReviewDecisionDiagnosticsRecord {
        ScmCaptureReviewDecisionDiagnosticsRecord {
            diagnostics_id: "diagnostics:review-decision".to_owned(),
            decision_count: 4,
            persisted_decision_count: 2,
            duplicate_decision_count: 1,
            blocked_decision_count: 1,
            accepted_count: 1,
            rejected_count: 1,
            needs_changes_count: 1,
            abandoned_count: 1,
            blocker_count: 2,
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
