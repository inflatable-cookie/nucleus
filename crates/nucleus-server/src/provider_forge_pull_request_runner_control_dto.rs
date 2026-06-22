//! Control DTOs for stopped forge pull-request runner outcomes.

use serde::{Deserialize, Serialize};

use crate::ForgePullRequestRunnerOutcomeDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub provider_request_prepared_count: usize,
    pub evidence_ref_count: usize,
    pub shell_execution_performed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

pub fn forge_pull_request_runner_control_dto(
    diagnostics: ForgePullRequestRunnerOutcomeDiagnosticsRecord,
) -> ForgePullRequestRunnerControlDto {
    ForgePullRequestRunnerControlDto {
        dto_id: "forge-pull-request-runner-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        outcome_count: diagnostics.outcome_count,
        completed_count: diagnostics.completed_count,
        failed_count: diagnostics.failed_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        blocker_count: diagnostics.blocker_count,
        provider_request_prepared_count: diagnostics.provider_request_prepared_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        shell_execution_performed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_pull_request_runner_control_dto_serializes_sanitized_counts() {
        let dto = forge_pull_request_runner_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: ForgePullRequestRunnerControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.outcome_count, 5);
        assert_eq!(decoded.provider_request_prepared_count, 2);
        assert!(!decoded.pull_request_created);
        assert!(!decoded.forge_effect_executed);
        assert!(!decoded.provider_effect_executed);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("raw_title"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> ForgePullRequestRunnerOutcomeDiagnosticsRecord {
        ForgePullRequestRunnerOutcomeDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            outcome_count: 5,
            completed_count: 1,
            failed_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            duplicate_noop_count: 1,
            persistence_blocked_count: 0,
            blocker_count: 2,
            provider_request_prepared_count: 2,
            evidence_ref_count: 3,
            shell_execution_performed: false,
            pull_request_created: false,
            forge_effect_executed: false,
            provider_effect_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_output_retained: false,
        }
    }
}
