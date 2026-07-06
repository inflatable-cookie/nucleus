use crate::{
    SelectedTaskOperatorActionBlocker, SelectedTaskOperatorActionDisposition,
    SelectedTaskOperatorActionGate, SelectedTaskOperatorActionGateInput,
    SelectedTaskOperatorActionGateSourceCounts, TaskWorkflowNoEffects,
};

use super::mapping::candidate;

pub fn selected_task_operator_action_gate(
    input: SelectedTaskOperatorActionGateInput,
) -> SelectedTaskOperatorActionGate {
    let readiness = input.readiness;
    let candidates = readiness
        .actions
        .iter()
        .map(|action| candidate(action, &readiness.task_id, &input.expected_revision))
        .collect::<Vec<_>>();
    let blockers = candidates
        .iter()
        .filter(|candidate| candidate.disposition == SelectedTaskOperatorActionDisposition::Blocked)
        .map(|candidate| SelectedTaskOperatorActionBlocker {
            family: candidate.family,
            reason: candidate.reason.clone(),
            evidence_refs: candidate.evidence_refs.clone(),
        })
        .collect::<Vec<_>>();

    SelectedTaskOperatorActionGate {
        gate_id: format!("selected-task-operator-action-gate:{}", readiness.task_id.0),
        project_id: readiness.project_id,
        task_id: readiness.task_id,
        expected_revision: input.expected_revision,
        actor_ref: input.actor_ref,
        source_counts: source_counts(&candidates),
        candidates,
        blockers,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}

fn source_counts(
    candidates: &[crate::SelectedTaskOperatorActionCandidate],
) -> SelectedTaskOperatorActionGateSourceCounts {
    SelectedTaskOperatorActionGateSourceCounts {
        readiness_actions: candidates.len(),
        task_command_candidates: count(
            candidates,
            SelectedTaskOperatorActionDisposition::TaskCommandCandidate,
        ),
        blocked_actions: count(candidates, SelectedTaskOperatorActionDisposition::Blocked),
        read_only_actions: count(candidates, SelectedTaskOperatorActionDisposition::ReadOnly),
        deferred_actions: count(candidates, SelectedTaskOperatorActionDisposition::Deferred),
        evidence_refs: candidates
            .iter()
            .map(|candidate| candidate.evidence_refs.len())
            .sum(),
        blocker_refs: candidates
            .iter()
            .map(|candidate| candidate.blocker_refs.len())
            .sum(),
    }
}

fn count(
    candidates: &[crate::SelectedTaskOperatorActionCandidate],
    disposition: SelectedTaskOperatorActionDisposition,
) -> usize {
    candidates
        .iter()
        .filter(|candidate| candidate.disposition == disposition)
        .count()
}
