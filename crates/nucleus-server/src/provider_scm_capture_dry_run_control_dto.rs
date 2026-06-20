//! Control DTOs for SCM capture dry-run diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureDryRunDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub skipped_preparation_count: usize,
    pub plan_count: usize,
    pub ready_plan_count: usize,
    pub unsupported_plan_count: usize,
    pub repair_required_plan_count: usize,
    pub blocker_count: usize,
    pub scm_dry_run_authority_granted: bool,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn scm_capture_dry_run_control_dto(
    diagnostics: ScmCaptureDryRunDiagnosticsRecord,
) -> ScmCaptureDryRunControlDto {
    ScmCaptureDryRunControlDto {
        dto_id: "scm-capture-dry-run-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        candidate_count: diagnostics.candidate_count,
        skipped_preparation_count: diagnostics.skipped_preparation_count,
        plan_count: diagnostics.plan_count,
        ready_plan_count: diagnostics.ready_plan_count,
        unsupported_plan_count: diagnostics.unsupported_plan_count,
        repair_required_plan_count: diagnostics.repair_required_plan_count,
        blocker_count: diagnostics.blocker_count,
        scm_dry_run_authority_granted: false,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_control_dto_serializes_sanitized_counts() {
        let dto = scm_capture_dry_run_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmCaptureDryRunControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.plan_count, 3);
        assert_eq!(decoded.ready_plan_count, 1);
        assert_eq!(decoded.unsupported_plan_count, 1);
        assert_eq!(decoded.repair_required_plan_count, 1);
        assert!(!decoded.scm_dry_run_authority_granted);
        assert!(!decoded.scm_capture_authority_granted);
        assert!(!decoded.raw_material_exposed);
        assert!(!json.contains("raw_provider"));
        assert!(!json.contains("live_handle"));
        assert!(!json.contains("command_request"));
    }

    fn diagnostics() -> ScmCaptureDryRunDiagnosticsRecord {
        ScmCaptureDryRunDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            candidate_count: 3,
            skipped_preparation_count: 0,
            plan_count: 3,
            ready_plan_count: 1,
            unsupported_plan_count: 1,
            repair_required_plan_count: 1,
            blocker_count: 2,
            scm_dry_run_authority_granted: false,
            scm_capture_authority_granted: false,
            scm_publish_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_material_exposed: false,
        }
    }
}
