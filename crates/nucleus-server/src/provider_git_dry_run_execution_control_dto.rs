//! Control DTOs for Git dry-run execution diagnostics.

use serde::{Deserialize, Serialize};

use crate::GitDryRunExecutionDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GitDryRunExecutionControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    #[ts(as = "u32")]
    pub execution_count: usize,
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
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_dry_run_execution_control_dto(
    diagnostics: GitDryRunExecutionDiagnosticsRecord,
) -> GitDryRunExecutionControlDto {
    GitDryRunExecutionControlDto {
        dto_id: "git-dry-run-execution-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        execution_count: diagnostics.execution_count,
        completed_count: diagnostics.completed_count,
        failed_count: diagnostics.failed_count,
        timed_out_count: diagnostics.timed_out_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        blocker_count: diagnostics.blocker_count,
        dry_run_executed_count: diagnostics.dry_run_executed_count,
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_execution_control_dto_serializes_sanitized_counts() {
        let dto = git_dry_run_execution_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: GitDryRunExecutionControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.execution_count, 5);
        assert_eq!(decoded.completed_count, 1);
        assert_eq!(decoded.blocked_count, 1);
        assert_eq!(decoded.dry_run_executed_count, 1);
        assert!(!decoded.commit_executed);
        assert!(!decoded.forge_effect_executed);
        assert!(!decoded.provider_write_executed);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_diff"));
        assert!(!json.contains("command_request"));
    }

    fn diagnostics() -> GitDryRunExecutionDiagnosticsRecord {
        GitDryRunExecutionDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            execution_count: 5,
            completed_count: 1,
            failed_count: 1,
            timed_out_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            duplicate_noop_count: 0,
            blocker_count: 2,
            dry_run_executed_count: 1,
            checkout_executed: false,
            branch_mutation_executed: false,
            commit_executed: false,
            push_executed: false,
            forge_effect_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_output_retained: false,
        }
    }
}
