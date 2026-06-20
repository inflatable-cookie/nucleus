//! Durable Codex live-smoke dispatch runner.
//!
//! This runner assembles the durable executor record path for a live smoke. It
//! does not execute provider I/O; execution remains a later explicit runner
//! concern.

use serde::{Deserialize, Serialize};

use crate::{
    durable_codex_live_smoke_boundary, durable_dispatch_executor_handoff,
    durable_dispatch_invocation_preflight, durable_dispatch_invocation_request,
    durable_provider_executor_command, durable_provider_executor_dispatch_admission,
    durable_provider_executor_dispatch_selection, CodexAppServerLiveExecutorMethod,
    DurableCodexLiveSmokeBoundaryRecord, DurableCodexLiveSmokeIntent,
    DurableDispatchExecutorHandoffInput, DurableDispatchExecutorHandoffRecord,
    DurableDispatchExecutorHandoffStatus, DurableDispatchInvocationPreflightInput,
    DurableDispatchInvocationPreflightRecord, DurableDispatchInvocationRequestInput,
    DurableDispatchInvocationRequestRecord, DurableProviderExecutorCommandId,
    DurableProviderExecutorCommandInput, DurableProviderExecutorCommandRecord,
    DurableProviderExecutorDispatchAdmissionInput, DurableProviderExecutorDispatchAdmissionRecord,
    DurableProviderExecutorDispatchSelectionInput, DurableProviderExecutorDispatchSelectionRecord,
    DurableProviderExecutorLane, DurableProviderExecutorMethod,
};

/// Input for an execution-free durable Codex live-smoke dispatch run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveSmokeDispatchRunInput {
    pub intent: DurableCodexLiveSmokeIntent,
    pub run_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub task_id: String,
    pub work_item_id: String,
    pub operator_confirmation_ref: String,
    pub evidence_refs: Vec<String>,
}

/// Durable live-smoke dispatch path result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeDispatchRunRecord {
    pub run_id: String,
    pub command: DurableProviderExecutorCommandRecord,
    pub selection: DurableProviderExecutorDispatchSelectionRecord,
    pub dispatch_admission: DurableProviderExecutorDispatchAdmissionRecord,
    pub preflight: DurableDispatchInvocationPreflightRecord,
    pub invocation_request: DurableDispatchInvocationRequestRecord,
    pub handoff: DurableDispatchExecutorHandoffRecord,
    pub boundary: DurableCodexLiveSmokeBoundaryRecord,
    pub reached_live_executor_boundary: bool,
    pub provider_write_executed: bool,
    pub executor_invoked: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Build the durable live-smoke dispatch path without provider execution.
pub fn durable_codex_live_smoke_dispatch_run(
    input: DurableCodexLiveSmokeDispatchRunInput,
) -> DurableCodexLiveSmokeDispatchRunRecord {
    let ids = SmokeIds::new(&input.run_id);
    let command = durable_provider_executor_command(command_input(&input, &ids));
    let selection = durable_provider_executor_dispatch_selection(selection_input(command.clone()));
    let dispatch_admission = durable_provider_executor_dispatch_admission(dispatch_input(
        selection.clone(),
        &input,
        &ids,
    ));
    let preflight = durable_dispatch_invocation_preflight(preflight_input(
        dispatch_admission.clone(),
        &input,
        &ids,
    ));
    let invocation_request =
        durable_dispatch_invocation_request(invocation_request_input(preflight.clone()));
    let handoff = durable_dispatch_executor_handoff(handoff_input(invocation_request.clone()));
    let boundary = durable_codex_live_smoke_boundary(crate::DurableCodexLiveSmokeBoundaryInput {
        handoff: handoff.clone(),
        intent: input.intent,
        smoke_evidence_refs: vec![format!("evidence:durable-live-smoke:{}", input.run_id)],
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
        raw_stream_requested: false,
    });
    let reached_live_executor_boundary =
        handoff.status == DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary;

    DurableCodexLiveSmokeDispatchRunRecord {
        run_id: input.run_id,
        command,
        selection,
        dispatch_admission,
        preflight,
        invocation_request,
        handoff,
        boundary,
        reached_live_executor_boundary,
        provider_write_executed: false,
        executor_invoked: false,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
    }
}

fn command_input(
    input: &DurableCodexLiveSmokeDispatchRunInput,
    ids: &SmokeIds,
) -> DurableProviderExecutorCommandInput {
    DurableProviderExecutorCommandInput {
        command_id: DurableProviderExecutorCommandId(ids.command_id.clone()),
        lane: DurableProviderExecutorLane::TaskBackedTurnStart,
        lane_admission_id: ids.lane_admission_id.clone(),
        provider_instance_id: input.provider_instance_id.clone(),
        runtime_session_ref: input.runtime_session_ref.clone(),
        write_attempt_id: ids.write_attempt_id.clone(),
        idempotency_key: ids.idempotency_key.clone(),
        task_id: Some(input.task_id.clone()),
        work_item_id: Some(input.work_item_id.clone()),
        method: DurableProviderExecutorMethod::TurnStart,
        evidence_refs: input.evidence_refs.clone(),
        operator_confirmation_ref: Some(input.operator_confirmation_ref.clone()),
        client_authority_requested: false,
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn selection_input(
    command: DurableProviderExecutorCommandRecord,
) -> DurableProviderExecutorDispatchSelectionInput {
    DurableProviderExecutorDispatchSelectionInput {
        command,
        latest_status: None,
        provider_ready_evidence_refs: vec!["evidence:provider-ready:durable-smoke".to_owned()],
        runtime_ready_evidence_refs: vec!["evidence:runtime-ready:durable-smoke".to_owned()],
        selection_evidence_refs: vec!["evidence:selection:durable-smoke".to_owned()],
        in_flight_write_attempt_ids: Vec::new(),
        stale_command_evidence: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn dispatch_input(
    selection: DurableProviderExecutorDispatchSelectionRecord,
    input: &DurableCodexLiveSmokeDispatchRunInput,
    ids: &SmokeIds,
) -> DurableProviderExecutorDispatchAdmissionInput {
    DurableProviderExecutorDispatchAdmissionInput {
        selection,
        dispatch_attempt_id: ids.dispatch_attempt_id.clone(),
        operator_confirmation_ref: Some(input.operator_confirmation_ref.clone()),
        runtime_session_evidence_refs: vec!["evidence:runtime-session:durable-smoke".to_owned()],
        provider_ready_evidence_refs: vec!["evidence:provider-ready:durable-smoke".to_owned()],
        admission_evidence_refs: vec!["evidence:dispatch-admission:durable-smoke".to_owned()],
        write_attempt_id: ids.write_attempt_id.clone(),
        idempotency_key: ids.idempotency_key.clone(),
        invoke_executor_requested: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn preflight_input(
    admission: DurableProviderExecutorDispatchAdmissionRecord,
    input: &DurableCodexLiveSmokeDispatchRunInput,
    ids: &SmokeIds,
) -> DurableDispatchInvocationPreflightInput {
    DurableDispatchInvocationPreflightInput {
        admission,
        operator_confirmation_ref: Some(input.operator_confirmation_ref.clone()),
        provider_ready_evidence_refs: vec!["evidence:provider-ready:durable-smoke".to_owned()],
        runtime_session_evidence_refs: vec!["evidence:runtime-session:durable-smoke".to_owned()],
        invocation_evidence_refs: vec!["evidence:invocation-preflight:durable-smoke".to_owned()],
        supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
        in_flight_invocation_attempt_ids: Vec::new(),
        stale_admission_evidence: false,
        write_attempt_id: ids.write_attempt_id.clone(),
        idempotency_key: ids.idempotency_key.clone(),
        executor_invocation_requested: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn invocation_request_input(
    preflight: DurableDispatchInvocationPreflightRecord,
) -> DurableDispatchInvocationRequestInput {
    DurableDispatchInvocationRequestInput {
        preflight,
        invocation_request_evidence_refs: vec![
            "evidence:invocation-request:durable-smoke".to_owned()
        ],
        executor_invocation_requested: false,
        background_execution_requested: false,
        provider_write_requested: false,
        raw_provider_material_requested: false,
        raw_callback_material_requested: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

fn handoff_input(
    request: DurableDispatchInvocationRequestRecord,
) -> DurableDispatchExecutorHandoffInput {
    DurableDispatchExecutorHandoffInput {
        request,
        supported_methods: vec![DurableProviderExecutorMethod::TurnStart],
        live_executor_method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
        payload_ref: Some("payload:durable-live-smoke:turn-start".to_owned()),
        handoff_evidence_refs: vec!["evidence:handoff:durable-smoke".to_owned()],
        executor_invocation_requested: false,
        provider_write_requested: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_requested: false,
        review_acceptance_requested: false,
        callback_answer_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        replacement_thread_promotion_requested: false,
        scm_mutation_requested: false,
    }
}

struct SmokeIds {
    command_id: String,
    lane_admission_id: String,
    dispatch_attempt_id: String,
    write_attempt_id: String,
    idempotency_key: String,
}

impl SmokeIds {
    fn new(run_id: &str) -> Self {
        Self {
            command_id: format!("durable-provider-executor-command:live-smoke:{run_id}"),
            lane_admission_id: format!("task-work-live-executor-admission:live-smoke:{run_id}"),
            dispatch_attempt_id: format!("dispatch-attempt:live-smoke:{run_id}"),
            write_attempt_id: format!("provider-transport-write:live-smoke:{run_id}"),
            idempotency_key: format!("idempotency:live-smoke:{run_id}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DurableCodexLiveSmokeBoundaryStatus, DurableDispatchInvocationPreflightStatus,
        DurableDispatchInvocationRequestStatus, DurableProviderExecutorCommandStatus,
        DurableProviderExecutorDispatchAdmissionStatus,
        DurableProviderExecutorDispatchSelectionStatus,
    };

    #[test]
    fn durable_codex_live_smoke_dispatch_dry_run_reaches_handoff_without_execution() {
        let record =
            durable_codex_live_smoke_dispatch_run(input(DurableCodexLiveSmokeIntent::DryRunOnly));

        assert_eq!(
            record.command.status,
            DurableProviderExecutorCommandStatus::AcceptedForPersistence
        );
        assert_eq!(
            record.selection.status,
            DurableProviderExecutorDispatchSelectionStatus::SelectedForDispatchAdmission
        );
        assert_eq!(
            record.dispatch_admission.status,
            DurableProviderExecutorDispatchAdmissionStatus::AcceptedForDispatch
        );
        assert_eq!(
            record.preflight.status,
            DurableDispatchInvocationPreflightStatus::AcceptedForInvocationRequest
        );
        assert_eq!(
            record.invocation_request.status,
            DurableDispatchInvocationRequestStatus::AcceptedForExecutorHandoff
        );
        assert_eq!(
            record.handoff.status,
            DurableDispatchExecutorHandoffStatus::ReadyForLiveExecutorBoundary
        );
        assert_eq!(
            record.boundary.status,
            DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
        );
        assert!(record.reached_live_executor_boundary);
        assert!(!record.provider_write_executed);
        assert!(!record.executor_invoked);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn durable_codex_live_smoke_dispatch_real_write_intent_reaches_boundary_without_execution() {
        let record = durable_codex_live_smoke_dispatch_run(input(
            DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
                confirmation_ref: "evidence:confirm-real-write".to_owned(),
                effect_ref: "evidence:execute-provider-write".to_owned(),
            },
        ));

        assert_eq!(
            record.boundary.status,
            DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite
        );
        assert!(record.reached_live_executor_boundary);
        assert!(!record.provider_write_executed);
        assert!(!record.executor_invoked);
        assert!(!record.raw_provider_material_retained);
    }

    #[test]
    fn durable_codex_live_smoke_dispatch_confirmation_without_effect_stays_blocked() {
        let record = durable_codex_live_smoke_dispatch_run(input(
            DurableCodexLiveSmokeIntent::ConfirmedRealWrite {
                confirmation_ref: "evidence:confirm-real-write".to_owned(),
            },
        ));

        assert_eq!(
            record.boundary.status,
            DurableCodexLiveSmokeBoundaryStatus::Blocked
        );
        assert!(!record.reached_live_executor_boundary || !record.provider_write_executed);
        assert!(!record.provider_write_executed);
    }

    fn input(intent: DurableCodexLiveSmokeIntent) -> DurableCodexLiveSmokeDispatchRunInput {
        DurableCodexLiveSmokeDispatchRunInput {
            intent,
            run_id: "fixture".to_owned(),
            provider_instance_id: "codex:fixture".to_owned(),
            runtime_session_ref: "runtime-session:fixture".to_owned(),
            task_id: "task:fixture".to_owned(),
            work_item_id: "work:fixture".to_owned(),
            operator_confirmation_ref: "operator-confirmation:fixture".to_owned(),
            evidence_refs: vec!["evidence:fixture".to_owned()],
        }
    }
}
