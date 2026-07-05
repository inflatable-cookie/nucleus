use nucleus_server::{
    ControlAcceptedMemoryProjectionImportBlockerDto,
    ControlAcceptedMemoryProjectionImportDiagnosticsDto,
};

pub(crate) fn accepted_memory_projection_import_response_lines(
    label: &str,
    diagnostics: ControlAcceptedMemoryProjectionImportDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", diagnostics.project_id),
        format!(
            "records candidates={} admissions={} conflicts={}",
            diagnostics.candidates.len(),
            diagnostics.admissions.len(),
            diagnostics.conflicts.len()
        ),
        format!(
            "counts source_records={} accepted_records={} out_of_scope_accepted_records={} skipped_records={} skipped_proposal_records={} skipped_unsupported_records={} skipped_decode_errors={} skipped_encode_errors={} input_files={} candidates={} ready_candidates={} blocked_candidates={} admitted_imports={} blocked_imports={} no_conflicts={} duplicate_noops={} semantic_conflicts={} policy_conflicts={} blocked_conflicts={} candidate_blockers={} admission_blockers={} conflict_blockers={} file_refs={}",
            diagnostics.counts.source_records,
            diagnostics.counts.accepted_records,
            diagnostics.counts.out_of_scope_accepted_records,
            diagnostics.counts.skipped_records,
            diagnostics.counts.skipped_proposal_records,
            diagnostics.counts.skipped_unsupported_records,
            diagnostics.counts.skipped_decode_errors,
            diagnostics.counts.skipped_encode_errors,
            diagnostics.counts.input_files,
            diagnostics.counts.candidates,
            diagnostics.counts.ready_candidates,
            diagnostics.counts.blocked_candidates,
            diagnostics.counts.admitted_imports,
            diagnostics.counts.blocked_imports,
            diagnostics.counts.no_conflicts,
            diagnostics.counts.duplicate_noops,
            diagnostics.counts.semantic_conflicts,
            diagnostics.counts.policy_conflicts,
            diagnostics.counts.blocked_conflicts,
            diagnostics.counts.candidate_blockers,
            diagnostics.counts.admission_blockers,
            diagnostics.counts.conflict_blockers,
            diagnostics.counts.file_refs
        ),
        format!(
            "flags projected_file_read_performed={} active_memory_apply_performed={} scm_effect_performed={} embedding_available={} provider_sync_available={} task_mutation_performed={} ui_effect_performed={}",
            diagnostics.projected_file_read_performed,
            diagnostics.active_memory_apply_performed,
            diagnostics.scm_effect_performed,
            diagnostics.embedding_available,
            diagnostics.provider_sync_available,
            diagnostics.task_mutation_performed,
            diagnostics.ui_effect_performed
        ),
    ];

    lines.extend(diagnostics.candidates.into_iter().map(|candidate| {
        format!(
            "candidate candidate_ref={} memory_id={} file_ref={} status={} body_kind={} blockers={}",
            candidate.candidate_ref,
            candidate.memory_id.unwrap_or_else(|| "none".to_owned()),
            candidate.file_ref,
            candidate.status,
            candidate
                .summary
                .as_ref()
                .map(|summary| summary.body_kind.clone())
                .unwrap_or_else(|| "none".to_owned()),
            blocker_list(candidate.blockers)
        )
    }));
    lines.extend(diagnostics.admissions.into_iter().map(|admission| {
        format!(
            "admission admission_ref={} candidate_ref={} memory_id={} file_ref={} status={} blockers={}",
            admission.admission_ref,
            admission.candidate_ref,
            admission.memory_id.unwrap_or_else(|| "none".to_owned()),
            admission.file_ref,
            admission.status,
            blocker_list(admission.blockers)
        )
    }));
    lines.extend(diagnostics.conflicts.into_iter().map(|conflict| {
        format!(
            "conflict conflict_ref={} admission_ref={} candidate_ref={} memory_id={} file_ref={} status={} blockers={}",
            conflict.conflict_ref,
            conflict.admission_ref,
            conflict.candidate_ref,
            conflict.memory_id.unwrap_or_else(|| "none".to_owned()),
            conflict.file_ref,
            conflict.status,
            blocker_list(conflict.blockers)
        )
    }));

    lines
}

fn blocker_list(blockers: Vec<ControlAcceptedMemoryProjectionImportBlockerDto>) -> String {
    if blockers.is_empty() {
        return "none".to_owned();
    }

    blockers
        .into_iter()
        .map(|blocker| match blocker.detail {
            Some(detail) if !detail.trim().is_empty() => {
                format!("{}:{detail}", blocker.kind)
            }
            _ => blocker.kind,
        })
        .collect::<Vec<_>>()
        .join(",")
}
