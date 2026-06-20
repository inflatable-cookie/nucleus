use super::*;

#[test]
fn live_evidence_completion_handler_composition_reads_persisted_completions() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_completion(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if record.timeline_entry_count == 1
            && record.completed_work_item_count == 1
            && record.repair_required_completion_ids.is_empty()
            && !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
    ));
}

#[test]
fn live_evidence_completion_missing_state_routing_returns_empty_read_model() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if record.timeline_entry_count == 0
            && record.completed_work_item_count == 0
            && record.skipped_completion_ids.is_empty()
            && record.repair_required_completion_ids.is_empty()
            && !record.client_mutation_authority
    ));
}

#[test]
fn live_evidence_completion_handler_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_completion(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::LiveEvidenceCompletion,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record)
        )) if !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
            && !record.raw_provider_material_exposed
    ));
}

#[test]
fn completion_scm_handler_routing_returns_missing_state_repair_diagnostics() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if !record.source_history_available
            && record.repair_required
            && record.candidate_count == 0
            && record.readiness_count == 0
            && record.adapter_label == "unconfigured"
            && !record.scm_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_persisted_history_source_returns_real_candidates() {
    let (_temp_dir, mut handler) = handler(None);
    persist_live_evidence_task_state_control(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if record.source_history_available
            && record.candidate_count == 1
            && record.readiness_count == 1
            && record.repair_required_count == 1
            && record.repair_required
            && !record.scm_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_handler_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmReadiness,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record)
        )) if !record.scm_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

#[test]
fn completion_scm_capture_handler_routing_reads_persisted_admissions() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_admission(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CompletionScmCapture));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(record)
        )) if record.admission_count == 1
            && record.admitted_count == 1
            && record.blocked_count == 0
            && !record.scm_capture_executed
            && !record.forge_change_request_created
    ));
}

#[test]
fn completion_scm_capture_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_admission(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CompletionScmCapture));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(record)
        )) if !record.scm_capture_executed
            && !record.scm_publish_executed
            && !record.forge_change_request_created
            && !record.forge_merge_executed
            && !record.provider_write_executed
            && !record.callback_response_executed
            && !record.interruption_executed
            && !record.recovery_executed
            && !record.raw_material_exposed
    ));
}

#[test]
fn completion_scm_capture_preparation_handler_routing_reads_persisted_records() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_preparation(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmCapturePreparation,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record)
        )) if record.plan_count == 1
            && record.ready_plan_count == 1
            && record.unsupported_plan_count == 0
            && !record.scm_capture_authority_granted
            && !record.forge_authority_granted
    ));
}

#[test]
fn completion_scm_capture_preparation_control_authority_keeps_diagnostics_read_only() {
    let (_temp_dir, mut handler) = handler(None);
    persist_completion_scm_capture_preparation(&handler);

    let response = handler.handle(diagnostics_request(
        DiagnosticsQuery::CompletionScmCapturePreparation,
    ));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record)
        )) if !record.scm_capture_authority_granted
            && !record.scm_publish_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
            && !record.raw_material_exposed
    ));
}

fn persist_live_evidence_completion<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_live_evidence_task_completion(
        handler.state(),
        crate::LiveEvidenceTaskCompletionPersistenceInput {
            admission: crate::LiveEvidenceTaskCompletionAdmissionRecord {
                admission_id: "completion-admission:handler".to_owned(),
                review_decision_id: "review-decision:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: "work:handler".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:completion-handler".to_owned()],
                status: crate::LiveEvidenceTaskCompletionAdmissionStatus::Admitted,
                blockers: Vec::new(),
                task_completion_admitted: true,
                provider_write_permitted: false,
                callback_response_permitted: false,
                cancellation_permitted: false,
                resume_permitted: false,
                scm_mutation_permitted: false,
                raw_provider_material_retained: false,
                raw_stream_retained: false,
            },
            existing_completion_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        },
    )
    .expect("persist live evidence completion");
}

fn persist_live_evidence_task_state_control<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_live_evidence_task_state_control(
        handler.state(),
        crate::LiveEvidenceTaskStateControlPersistenceInput {
            control: crate::LiveEvidenceTaskStateControlRecord {
                control_id: "control:handler".to_owned(),
                request_id: "request:handler".to_owned(),
                admission: crate::LiveEvidenceTaskStateTransitionAdmissionRecord {
                    admission_id: "admission:handler".to_owned(),
                    task_id: "task:handler".to_owned(),
                    work_item_id: "work:handler".to_owned(),
                    completion_id: "completion:handler".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:task-state-handler".to_owned()],
                    status: crate::LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted,
                    blockers: Vec::new(),
                    task_state_transition_admitted: true,
                    provider_authority_granted: false,
                    callback_authority_granted: false,
                    interruption_authority_granted: false,
                    recovery_authority_granted: false,
                    scm_authority_granted: false,
                    raw_material_retained: false,
                },
                history: crate::LiveEvidenceTaskStateHistoryProjectionRecord {
                    projection_id: "history:handler".to_owned(),
                    entries: vec![crate::LiveEvidenceTaskStateHistoryEntry {
                        history_entry_id: "history:handler".to_owned(),
                        admission_id: "admission:handler".to_owned(),
                        task_id: "task:handler".to_owned(),
                        work_item_id: "work:handler".to_owned(),
                        completion_id: "completion:handler".to_owned(),
                        operator_ref: "operator:tom".to_owned(),
                        evidence_refs: vec!["evidence:task-state-handler".to_owned()],
                        task_state: "completed".to_owned(),
                    }],
                    skipped_admission_ids: Vec::new(),
                    provider_authority_granted: false,
                    scm_authority_granted: false,
                    raw_material_exposed: false,
                },
                task_state_mutation_requested: true,
                provider_authority_granted: false,
                callback_authority_granted: false,
                interruption_authority_granted: false,
                recovery_authority_granted: false,
                scm_authority_granted: false,
                raw_material_exposed: false,
            },
            existing_control_ids: Vec::new(),
            raw_material_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            scm_mutation_requested: false,
        },
    )
    .expect("persist task-state control");
}

fn persist_completion_scm_capture_admission<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_completion_scm_capture_admission(
        handler.state(),
        crate::CompletionScmCaptureAdmissionPersistenceInput {
            admission: crate::CompletionScmCaptureAdmissionRecord {
                admission_id: "admission:capture-handler".to_owned(),
                request_id: "request:capture-handler".to_owned(),
                readiness_id: "readiness:capture-handler".to_owned(),
                candidate_id: "candidate:capture-handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:capture-handler".to_owned()],
                status: crate::CompletionScmCaptureAdmissionStatus::Admitted,
                blockers: Vec::new(),
                capture_admitted: true,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_change_request_created: false,
                forge_merge_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_material_exposed: false,
            },
            existing_admission_ids: Vec::new(),
            raw_material_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist completion scm capture admission");
}

fn persist_completion_scm_capture_preparation<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_completion_scm_capture_preparation(
        handler.state(),
        crate::CompletionScmCapturePreparationPersistenceInput {
            plan_item: crate::CompletionScmCapturePlanItem {
                plan_item_id: "plan:handler".to_owned(),
                preparation_candidate_id: "prep:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                status: crate::CompletionScmCapturePlanStatus::Ready,
                blockers: Vec::new(),
            },
            admission_id: "admission:handler".to_owned(),
            readiness_id: "readiness:handler".to_owned(),
            capture_candidate_id: "candidate:handler".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:preparation-handler".to_owned()],
            existing_preparation_ids: Vec::new(),
            raw_material_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist completion scm capture preparation");
}
