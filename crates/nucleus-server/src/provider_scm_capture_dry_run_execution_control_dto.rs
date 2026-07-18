//! Control DTOs for SCM capture dry-run execution diagnostics.

use serde::{Deserialize, Serialize};

use crate::ScmCaptureDryRunExecutionDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ScmCaptureDryRunExecutionControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub receipt_count: usize,
    #[ts(as = "u32")]
    pub accepted_count: usize,
    #[ts(as = "u32")]
    pub completed_count: usize,
    #[ts(as = "u32")]
    pub failed_count: usize,
    #[ts(as = "u32")]
    pub timed_out_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub duplicate_noop_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub dry_run_executed_count: usize,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn scm_capture_dry_run_execution_control_dto(
    diagnostics: ScmCaptureDryRunExecutionDiagnosticsRecord,
) -> ScmCaptureDryRunExecutionControlDto {
    ScmCaptureDryRunExecutionControlDto {
        dto_id: "scm-capture-dry-run-execution-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        receipt_count: diagnostics.receipt_count,
        accepted_count: diagnostics.accepted_count,
        completed_count: diagnostics.completed_count,
        failed_count: diagnostics.failed_count,
        timed_out_count: diagnostics.timed_out_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        blocker_count: diagnostics.blocker_count,
        dry_run_executed_count: diagnostics.dry_run_executed_count,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scm_capture_dry_run_execution_control_dto_serializes_sanitized_counts() {
        let dto = scm_capture_dry_run_execution_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ScmCaptureDryRunExecutionControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.receipt_count, 6);
        assert_eq!(decoded.completed_count, 1);
        assert_eq!(decoded.blocked_count, 1);
        assert_eq!(decoded.dry_run_executed_count, 1);
        assert!(!decoded.scm_capture_executed);
        assert!(!decoded.forge_authority_granted);
        assert!(!decoded.raw_material_exposed);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
        assert!(!json.contains("command_request"));
    }

    fn diagnostics() -> ScmCaptureDryRunExecutionDiagnosticsRecord {
        ScmCaptureDryRunExecutionDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            receipt_count: 6,
            accepted_count: 1,
            completed_count: 1,
            failed_count: 1,
            timed_out_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            duplicate_noop_count: 0,
            blocker_count: 2,
            dry_run_executed_count: 1,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_material_exposed: false,
        }
    }
}
