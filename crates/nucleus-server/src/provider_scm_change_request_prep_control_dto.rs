//! Control DTOs for SCM change-request preparation diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmChangeRequestPrepDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestPrepControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub adapter_neutral: bool,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn scm_change_request_prep_control_dto(
    diagnostics: ScmChangeRequestPrepDiagnosticsRecord,
) -> ScmChangeRequestPrepControlDto {
    ScmChangeRequestPrepControlDto {
        dto_id: "scm-change-request-prep-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        admission_count: diagnostics.admission_count,
        admitted_count: diagnostics.admitted_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        blocker_count: diagnostics.blocker_count,
        adapter_neutral: true,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
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
    fn scm_change_request_prep_control_dto_serializes_sanitized_counts() {
        let dto = scm_change_request_prep_control_dto(ScmChangeRequestPrepDiagnosticsRecord {
            diagnostics_id: "diagnostics:prep".to_owned(),
            admission_count: 3,
            admitted_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            blocker_count: 2,
            adapter_neutral: true,
            branch_or_snapshot_authority_granted: false,
            commit_or_publish_authority_granted: false,
            push_or_remote_publish_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            raw_output_retained: false,
        });
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmChangeRequestPrepControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.admission_count, 3);
        assert_eq!(decoded.blocker_count, 2);
        assert!(decoded.adapter_neutral);
        assert!(!decoded.branch_or_snapshot_authority_granted);
        assert!(!decoded.forge_authority_granted);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
    }
}
