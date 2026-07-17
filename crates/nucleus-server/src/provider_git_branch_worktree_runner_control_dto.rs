//! Control DTOs for Git branch/worktree runner outcomes.

use crate::provider_no_effects::{ForgeScmNoEffects};
use serde::{Deserialize, Serialize};

use crate::GitBranchWorktreeRunnerOutcomeDiagnosticsRecord;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeRunnerControlDto {
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
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

pub fn git_branch_worktree_runner_control_dto(
    diagnostics: GitBranchWorktreeRunnerOutcomeDiagnosticsRecord,
) -> GitBranchWorktreeRunnerControlDto {
    GitBranchWorktreeRunnerControlDto {
        dto_id: "git-branch-worktree-runner-control-dto".to_owned(),
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
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_branch_worktree_runner_control_dto_serializes_sanitized_counts() {
        let dto = git_branch_worktree_runner_control_dto(diagnostics());
        let json = serde_json::to_string(&dto).expect("serialize dto");
        let decoded: GitBranchWorktreeRunnerControlDto =
            serde_json::from_str(&json).expect("deserialize dto");

        assert_eq!(decoded, dto);
        assert_eq!(decoded.outcome_count, 5);
        assert_eq!(decoded.completed_count, 1);
        assert_eq!(decoded.repair_required_count, 1);
        assert_eq!(decoded.evidence_ref_count, 3);
        assert!(!decoded.commit_created);
        assert!(!decoded.no_effects.forge_effect_executed);
        assert!(!decoded.no_effects.provider_effect_executed);
        assert!(!decoded.no_effects.raw_output_retained);
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("argv"));
        assert!(!json.contains("provider_payload"));
    }

    fn diagnostics() -> GitBranchWorktreeRunnerOutcomeDiagnosticsRecord {
        GitBranchWorktreeRunnerOutcomeDiagnosticsRecord {
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
            checkout_executed: false,
            branch_created: false,
            worktree_created: false,
            commit_created: false,
            push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
        }
    }
}
