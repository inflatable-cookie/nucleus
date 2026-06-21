use super::*;

#[test]
fn adapter_neutral_chain_control_dto_serializes_sanitized_counts() {
    let projection = crate::adapter_neutral_change_request_chain_projection(
        crate::AdapterNeutralChangeRequestChainInput {
            adapter_plans: crate::scm_change_request_adapter_plan_records(
                crate::ScmChangeRequestAdapterPlanRecordsInput {
                    preparations: vec![preparation(1, "git"), preparation(2, "convergence")],
                },
            ),
        },
    );
    let persistence = crate::adapter_neutral_change_request_chain_persistence(
        crate::AdapterNeutralChangeRequestChainPersistenceInput {
            projections: vec![projection.clone()],
            existing_projection_ids: Vec::new(),
            raw_material_present: false,
            scm_execution_requested: false,
            forge_execution_requested: false,
            provider_write_requested: false,
            task_mutation_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    );
    let dto = adapter_neutral_change_request_chain_control_dto(
        persistence,
        crate::adapter_neutral_change_request_chain_diagnostics(projection),
    );
    let json = serde_json::to_string(&dto).expect("serialize dto");
    let decoded: AdapterNeutralChangeRequestChainControlDto =
        serde_json::from_str(&json).expect("deserialize dto");

    assert_eq!(decoded, dto);
    assert_eq!(decoded.persisted_projection_count, 1);
    assert_eq!(decoded.stage_count, 7);
    assert_eq!(decoded.git_like_provider_ref_count, 4);
    assert_eq!(decoded.convergence_like_provider_ref_count, 3);
    assert!(!decoded.mutation_authority_granted);
    assert!(!decoded.scm_execution_permitted);
    assert!(!decoded.provider_write_permitted);
    assert!(!decoded.raw_material_retained);
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_diff"));
    assert!(!json.contains("provider_payload"));
}

#[test]
fn adapter_neutral_chain_control_dto_reports_duplicate_and_blocked_counts() {
    let projection = crate::adapter_neutral_change_request_chain_projection(
        crate::AdapterNeutralChangeRequestChainInput {
            adapter_plans: crate::scm_change_request_adapter_plan_records(
                crate::ScmChangeRequestAdapterPlanRecordsInput {
                    preparations: vec![preparation(1, "git")],
                },
            ),
        },
    );
    let duplicate_id = format!(
        "adapter-neutral-change-request-chain-persistence:{}",
        projection.projection_id
    );
    let duplicate_persistence = crate::adapter_neutral_change_request_chain_persistence(
        crate::AdapterNeutralChangeRequestChainPersistenceInput {
            projections: vec![projection.clone()],
            existing_projection_ids: vec![duplicate_id],
            raw_material_present: false,
            scm_execution_requested: false,
            forge_execution_requested: false,
            provider_write_requested: false,
            task_mutation_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    );
    let dto = adapter_neutral_change_request_chain_control_dto(
        duplicate_persistence,
        crate::adapter_neutral_change_request_chain_diagnostics(projection),
    );

    assert_eq!(dto.persisted_projection_count, 0);
    assert_eq!(dto.duplicate_projection_count, 1);
    assert_eq!(dto.blocked_projection_count, 0);
}

fn preparation(index: usize, adapter_label: &str) -> crate::ScmChangeRequestPrepPersistenceRecord {
    crate::ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: format!("prep:{index}"),
        admission_id: format!("admission:{index}"),
        decision_id: format!("decision:{index}"),
        readiness_id: format!("readiness:{index}"),
        workflow_id: format!("workflow:{index}"),
        task_id: format!("task:{index}"),
        work_item_id: Some(format!("work:{index}")),
        completion_id: Some(format!("completion:{index}")),
        repo_id: format!("repo:{index}"),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: adapter_label.to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec![format!("evidence:{index}")],
        admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        status: crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_preparation_detected: false,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}
