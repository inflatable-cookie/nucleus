use super::*;

pub(super) fn diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: DiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let task_agent = || {
        read_task_agent_work_unit_source_records(handler.state())
            .map(|records| task_agent_diagnostics(&records))
            .map_err(storage_error)
    };
    let live_evidence_completion =
        || live_evidence_completion_diagnostics_from_state(handler.state());
    let completion_scm_readiness =
        || completion_scm_readiness_diagnostics_from_state(handler.state());
    let completion_scm_capture = || completion_scm_capture_diagnostics_from_state(handler.state());
    let completion_scm_capture_preparation =
        || completion_scm_capture_preparation_diagnostics_from_state(handler.state());
    let scm_capture_dry_run = || scm_capture_dry_run_diagnostics_from_state(handler.state());
    let scm_capture_dry_run_execution =
        || scm_capture_dry_run_execution_diagnostics_from_state(handler.state());
    let git_dry_run_execution = || git_dry_run_execution_diagnostics_from_state(handler.state());
    let scm_capture_workflow = || scm_capture_workflow_diagnostics_from_state(handler.state());
    let scm_capture_review = || scm_capture_review_diagnostics_from_state(handler.state());
    let scm_capture_review_decision =
        || scm_capture_review_decision_diagnostics_from_state(handler.state());
    let scm_change_request_preparation =
        || scm_change_request_preparation_diagnostics_from_state(handler.state());

    match query {
        DiagnosticsQuery::Steward => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Steward(empty_steward_diagnostics()),
        )),
        DiagnosticsQuery::Effigy => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Effigy(empty_effigy_diagnostics()),
        )),
        DiagnosticsQuery::ManagementSync => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ManagementSync(empty_sync_diagnostics()),
        )),
        DiagnosticsQuery::ScmSession => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmSession(empty_scm_session_diagnostics()),
        )),
        DiagnosticsQuery::TaskAgent => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::TaskAgent(task_agent()?),
        )),
        DiagnosticsQuery::CodexProvider => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(codex_provider_diagnostics_from_state(
                handler.state(),
            )?),
        )),
        DiagnosticsQuery::LiveEvidenceCompletion => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(live_evidence_completion()?),
        )),
        DiagnosticsQuery::CompletionScmReadiness => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(completion_scm_readiness()?),
        )),
        DiagnosticsQuery::CompletionScmCapture => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(completion_scm_capture()?),
        )),
        DiagnosticsQuery::CompletionScmCapturePreparation => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(
                completion_scm_capture_preparation()?,
            ),
        )),
        DiagnosticsQuery::ScmCaptureDryRun => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(scm_capture_dry_run()?),
        )),
        DiagnosticsQuery::ScmCaptureDryRunExecution => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(
                scm_capture_dry_run_execution()?
            ),
        )),
        DiagnosticsQuery::GitDryRunExecution => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::GitDryRunExecution(git_dry_run_execution()?),
        )),
        DiagnosticsQuery::ScmCaptureWorkflow => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(scm_capture_workflow()?),
        )),
        DiagnosticsQuery::ScmCaptureReview => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReview(scm_capture_review()?),
        )),
        DiagnosticsQuery::ScmCaptureReviewDecision => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(scm_capture_review_decision()?),
        )),
        DiagnosticsQuery::ScmChangeRequestPreparation => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(
                scm_change_request_preparation()?,
            ),
        )),
        DiagnosticsQuery::All => Ok(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::All(ServerDiagnosticsSnapshot {
                steward: empty_steward_diagnostics(),
                effigy: empty_effigy_diagnostics(),
                management_sync: empty_sync_diagnostics(),
                scm_session: empty_scm_session_diagnostics(),
                task_agent: task_agent()?,
                codex_provider: codex_provider_diagnostics_from_state(handler.state())?,
                live_evidence_completion: live_evidence_completion()?,
                completion_scm_readiness: completion_scm_readiness()?,
                completion_scm_capture: completion_scm_capture()?,
                completion_scm_capture_preparation: completion_scm_capture_preparation()?,
                scm_capture_dry_run: scm_capture_dry_run()?,
                scm_capture_dry_run_execution: scm_capture_dry_run_execution()?,
                git_dry_run_execution: git_dry_run_execution()?,
                scm_capture_workflow: scm_capture_workflow()?,
                scm_capture_review: scm_capture_review()?,
                scm_capture_review_decision: scm_capture_review_decision()?,
                scm_change_request_preparation: scm_change_request_preparation()?,
            }),
        )),
    }
}

fn scm_change_request_preparation_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmChangeRequestPrepControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = crate::read_scm_change_request_prep_records(state).map_err(storage_error)?;
    Ok(scm_change_request_prep_control_dto(
        scm_change_request_prep_diagnostics_from_persisted_records(records),
    ))
}

fn scm_capture_review_decision_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmCaptureReviewDecisionControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = crate::read_scm_capture_review_decisions(state).map_err(storage_error)?;
    Ok(scm_capture_review_decision_control_dto(
        scm_capture_review_decision_diagnostics(records),
    ))
}

fn scm_capture_review_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmCaptureReviewControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_git_dry_run_executions(state).map_err(storage_error)?;
    let readiness = records
        .into_iter()
        .map(|record| {
            let execution_id = record.persisted_execution_id.clone();
            let workflow = scm_capture_workflow_projection(ScmCaptureWorkflowProjectionInput {
                workflow_id: format!("scm-capture-workflow:{execution_id}"),
                task_id: "unknown".to_owned(),
                work_item_id: None,
                completion_id: None,
                repo_id: record.repo_id.clone(),
                adapter_label: "git".to_owned(),
                completion_capture_ref: None,
                dry_run_plan_ref: None,
                git_execution: Some(record),
                diagnostics_ref: Some("diagnostics:git-dry-run-execution".to_owned()),
                evidence_refs: vec![execution_id],
            });
            scm_capture_review_readiness(ScmCaptureReviewReadinessInput {
                workflow,
                operator_ref: "operator:unassigned".to_owned(),
            })
        })
        .collect();
    Ok(scm_capture_review_control_dto(
        scm_capture_review_diagnostics(readiness),
    ))
}

fn scm_capture_workflow_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmCaptureWorkflowControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_git_dry_run_executions(state).map_err(storage_error)?;
    let workflows = records
        .into_iter()
        .map(|record| {
            let execution_id = record.persisted_execution_id.clone();
            scm_capture_workflow_projection(ScmCaptureWorkflowProjectionInput {
                workflow_id: format!("scm-capture-workflow:{execution_id}"),
                task_id: "unknown".to_owned(),
                work_item_id: None,
                completion_id: None,
                repo_id: record.repo_id.clone(),
                adapter_label: "git".to_owned(),
                completion_capture_ref: None,
                dry_run_plan_ref: None,
                git_execution: Some(record),
                diagnostics_ref: Some("diagnostics:git-dry-run-execution".to_owned()),
                evidence_refs: vec![execution_id],
            })
        })
        .collect();
    Ok(scm_capture_workflow_control_dto(
        scm_capture_workflow_diagnostics(workflows),
    ))
}

fn git_dry_run_execution_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::GitDryRunExecutionControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_git_dry_run_executions(state).map_err(storage_error)?;
    Ok(git_dry_run_execution_control_dto(
        git_dry_run_execution_diagnostics_from_persisted_records(records),
    ))
}

fn scm_capture_dry_run_execution_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmCaptureDryRunExecutionControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_scm_capture_dry_run_execution_receipts(state).map_err(storage_error)?;
    Ok(scm_capture_dry_run_execution_control_dto(
        scm_capture_dry_run_execution_diagnostics_from_persisted_records(records),
    ))
}

fn scm_capture_dry_run_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::ScmCaptureDryRunControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_scm_capture_dry_run_plans(state).map_err(storage_error)?;
    Ok(scm_capture_dry_run_control_dto(
        scm_capture_dry_run_diagnostics_from_persisted_records(records),
    ))
}

fn completion_scm_capture_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::CompletionScmCaptureControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_completion_scm_capture_admissions(state).map_err(storage_error)?;
    Ok(completion_scm_capture_control_dto(
        completion_scm_capture_diagnostics_from_persisted_admissions(records),
    ))
}

fn completion_scm_capture_preparation_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::CompletionScmCapturePreparationControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_completion_scm_capture_preparations(state).map_err(storage_error)?;
    Ok(completion_scm_capture_preparation_control_dto(
        completion_scm_capture_preparation_diagnostics_from_persisted_records(records),
    ))
}

fn completion_scm_readiness_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::CompletionScmControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let records = read_live_evidence_task_state_control_records(state).map_err(storage_error)?;
    let history = if records.is_empty() {
        None
    } else {
        Some(live_evidence_task_state_history_from_persisted_controls(
            records,
        ))
    };

    Ok(completion_scm_control_dto(completion_scm_read_model(
        CompletionScmReadModelInput {
            history,
            adapter_label: "unconfigured".to_owned(),
            workflow_label: "unconfigured".to_owned(),
            adapter_supports_change_requests: false,
            adapter_available: false,
        },
    )))
}

fn empty_steward_diagnostics() -> crate::StewardDiagnosticsDto {
    steward_diagnostics(&[], &[], &[])
}

fn empty_effigy_diagnostics() -> crate::EffigyDiagnosticsDto {
    let integration =
        nucleus_native_harness::NativeEffigyProjectIntegration::disabled("effigy unavailable");
    effigy_diagnostics(&integration, None, None)
}

fn empty_sync_diagnostics() -> crate::SyncDiagnosticsDto {
    sync_diagnostics(&[], &[], &[], &[])
}

fn empty_scm_session_diagnostics() -> crate::ScmSessionDiagnosticsDto {
    scm_session_diagnostics(&[], &[], &[])
}

fn codex_provider_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::CodexProviderDiagnosticsDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let live_executor_records =
        read_codex_live_executor_outcome_records(state).map_err(storage_error)?;
    let durable_executor_commands =
        read_durable_provider_executor_command_records(state).map_err(storage_error)?;

    Ok(codex_provider_diagnostics(
        codex_ingestion_diagnostics(&[]),
        codex_live_spawn_smoke_diagnostics(&[]),
        codex_live_executor_diagnostics(&live_executor_records),
        codex_task_backed_live_execution_diagnostics(&[], &[]),
        codex_turn_start_diagnostics(&[]),
        codex_subscription_diagnostics(&[], &[]),
        codex_transport_executor_diagnostics(&[], &[], &[], &[], &[], &[], &[]),
        codex_callback_diagnostics(&[]),
        codex_callback_response_execution_diagnostics(&[], &[]),
        codex_interruption_diagnostics(&[]),
        codex_interruption_execution_diagnostics(&[], &[]),
        codex_recovery_diagnostics(&[]),
        codex_recovery_execution_diagnostics(&[], &[]),
        durable_provider_executor_diagnostics(
            &durable_executor_commands,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
        ),
    ))
}

fn live_evidence_completion_diagnostics_from_state<B>(
    state: &ServerStateService<B>,
) -> Result<crate::LiveEvidenceCompletionControlDto, ServerControlError>
where
    B: LocalStoreBackend,
{
    let completions = read_live_evidence_task_completions(state).map_err(storage_error)?;
    Ok(live_evidence_completion_control_dto(
        live_evidence_completion_read_model(LiveEvidenceCompletionReadModelInput { completions }),
    ))
}
