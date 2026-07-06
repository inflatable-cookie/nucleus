use nucleus_server::ControlSelectedTaskOperatorActionGateDto;

pub(crate) fn selected_task_operator_action_gate_response_lines(
    label: &str,
    gate: ControlSelectedTaskOperatorActionGateDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("gate_id={}", gate.gate_id),
        format!("project_id={}", gate.project_id),
        format!("task_id={}", gate.task_id),
        format!(
            "expected_revision={}",
            gate.expected_revision.as_deref().unwrap_or("required_at_command_time")
        ),
        format!("actor_ref={}", gate.actor_ref.as_deref().unwrap_or("none")),
        format!(
            "counts readiness_actions={} task_command_candidates={} blocked={} read_only={} deferred={} evidence_refs={} blocker_refs={}",
            gate.source_counts.readiness_actions,
            gate.source_counts.task_command_candidates,
            gate.source_counts.blocked_actions,
            gate.source_counts.read_only_actions,
            gate.source_counts.deferred_actions,
            gate.source_counts.evidence_refs,
            gate.source_counts.blocker_refs
        ),
        format!(
            "no_effects task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            gate.no_effects.task_mutation_performed,
            gate.no_effects.provider_execution_performed,
            gate.no_effects.provider_write_performed,
            gate.no_effects.scm_or_forge_mutation_performed,
            gate.no_effects.accepted_memory_apply_performed,
            gate.no_effects.planning_apply_performed,
            gate.no_effects.projection_write_performed,
            gate.no_effects.agent_scheduling_performed,
            gate.no_effects.ui_effect_performed
        ),
        "payloads_exposed=false".to_owned(),
        "client_can_execute=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
    ];

    lines.extend(gate.candidates.into_iter().map(|candidate| {
        let command = candidate
            .task_command
            .as_ref()
            .map(|command| command.action.as_str())
            .unwrap_or("none");
        let expected_revision = if candidate.expected_revision_required {
            candidate
                .task_command
                .as_ref()
                .and_then(|command| command.expected_revision.as_deref())
                .unwrap_or("required_at_command_time")
        } else {
            "not_applicable"
        };
        format!(
            "candidate family={} disposition={} readiness_status={} task_command={} expected_revision_required={} expected_revision={} reason_required={} evidence_refs={} blocker_refs={} reason={}",
            candidate.family,
            candidate.disposition,
            candidate.readiness_status,
            command,
            candidate.expected_revision_required,
            expected_revision,
            candidate.reason_required,
            candidate.evidence_refs.len(),
            candidate.blocker_refs.len(),
            candidate.reason
        )
    }));
    lines.extend(gate.blockers.into_iter().map(|blocker| {
        format!(
            "blocker family={} evidence_refs={} reason={}",
            blocker.family,
            blocker.evidence_refs.len(),
            blocker.reason
        )
    }));

    lines
}
