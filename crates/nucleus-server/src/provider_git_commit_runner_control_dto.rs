//! Control DTOs for Git commit runner outcomes.

use serde::{Deserialize, Serialize};

use crate::GitCommitRunnerOutcomeDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitRunnerControlDto {
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
    pub primary_tree_count: usize,
    pub isolated_worktree_count: usize,
    pub evidence_ref_count: usize,
    pub shell_execution_performed: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_commit_runner_control_dto(
    diagnostics: GitCommitRunnerOutcomeDiagnosticsRecord,
) -> GitCommitRunnerControlDto {
    GitCommitRunnerControlDto {
        dto_id: "git-commit-runner-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        outcome_count: diagnostics.outcome_count,
        completed_count: diagnostics.completed_count,
        failed_count: diagnostics.failed_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        blocker_count: diagnostics.blocker_count,
        primary_tree_count: diagnostics.primary_tree_count,
        isolated_worktree_count: diagnostics.isolated_worktree_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        shell_execution_performed: false,
        commit_created: false,
        push_executed: false,
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
    fn git_commit_runner_control_dto_serializes_sanitized_counts() {
        let dto = git_commit_runner_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: GitCommitRunnerControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.outcome_count, 5);
        assert_eq!(decoded.completed_count, 1);
        assert_eq!(decoded.repair_required_count, 1);
        assert_eq!(decoded.evidence_ref_count, 3);
        assert!(!decoded.commit_created);
        assert!(!decoded.push_executed);
        assert!(!decoded.forge_effect_executed);
        assert!(!decoded.provider_effect_executed);
        assert!(!decoded.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("argv"));
        assert!(!json.contains("commit_message_text"));
    }

    fn diagnostics() -> GitCommitRunnerOutcomeDiagnosticsRecord {
        GitCommitRunnerOutcomeDiagnosticsRecord {
            diagnostics_id: "diagnostics:1".to_owned(),
            outcome_count: 5,
            completed_count: 1,
            failed_count: 1,
            blocked_count: 1,
            repair_required_count: 1,
            duplicate_noop_count: 1,
            persistence_blocked_count: 0,
            blocker_count: 2,
            primary_tree_count: 3,
            isolated_worktree_count: 2,
            evidence_ref_count: 3,
            shell_execution_performed: false,
            commit_created: false,
            push_executed: false,
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
