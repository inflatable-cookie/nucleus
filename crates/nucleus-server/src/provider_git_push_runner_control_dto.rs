//! Control DTOs for Git push runner outcomes.

use crate::provider_no_effects::{ForgeScmNoEffects};
use serde::{Deserialize, Serialize};

use crate::GitPushRunnerOutcomeDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushRunnerControlDto {
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
    pub remote_target_count: usize,
    pub evidence_ref_count: usize,
    pub shell_execution_performed: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

pub fn git_push_runner_control_dto(
    diagnostics: GitPushRunnerOutcomeDiagnosticsRecord,
) -> GitPushRunnerControlDto {
    GitPushRunnerControlDto {
        dto_id: "git-push-runner-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        outcome_count: diagnostics.outcome_count,
        completed_count: diagnostics.completed_count,
        failed_count: diagnostics.failed_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        blocker_count: diagnostics.blocker_count,
        remote_target_count: diagnostics.remote_target_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_push_runner_control_dto_serializes_sanitized_counts() {
        let dto = git_push_runner_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: GitPushRunnerControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.outcome_count, 5);
        assert_eq!(decoded.completed_count, 1);
        assert_eq!(decoded.repair_required_count, 1);
        assert_eq!(decoded.remote_target_count, 3);
        assert!(!decoded.push_executed);
        assert!(!decoded.no_effects.pull_request_created);
        assert!(!decoded.no_effects.forge_effect_executed);
        assert!(!decoded.no_effects.provider_effect_executed);
        assert!(!decoded.no_effects.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("argv"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> GitPushRunnerOutcomeDiagnosticsRecord {
        GitPushRunnerOutcomeDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            outcome_count: 5,
            completed_count: 1,
            failed_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            duplicate_noop_count: 1,
            persistence_blocked_count: 0,
            blocker_count: 2,
            remote_target_count: 3,
            evidence_ref_count: 3,
            shell_execution_performed: false,
            push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
        }
    }
}
