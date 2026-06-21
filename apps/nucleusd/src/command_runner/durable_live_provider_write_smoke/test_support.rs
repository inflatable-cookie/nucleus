use nucleus_server::{
    durable_codex_live_provider_write_invocation_gate, durable_codex_live_smoke_dispatch_run,
    DurableCodexLiveProviderWriteInvocationGateInput,
    DurableCodexLiveProviderWriteInvocationGateRecord, DurableCodexLiveSmokeDispatchRunInput,
    DurableCodexLiveSmokeDispatchRunRecord, DurableCodexLiveSmokeIntent,
};

pub(super) fn test_gate_and_run(
    label: &str,
) -> (
    DurableCodexLiveSmokeDispatchRunRecord,
    DurableCodexLiveProviderWriteInvocationGateRecord,
) {
    let run = durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
        intent: DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
            confirmation_ref: format!("evidence:{label}:confirm"),
            effect_ref: format!("evidence:{label}:effect"),
        },
        run_id: label.to_owned(),
        provider_instance_id: format!("codex:{label}"),
        runtime_session_ref: format!("runtime-session:{label}"),
        task_id: format!("task:{label}"),
        work_item_id: format!("work:{label}"),
        operator_confirmation_ref: format!("operator-confirmation:{label}"),
        evidence_refs: vec![format!("evidence:{label}:command")],
    });
    let gate = durable_codex_live_provider_write_invocation_gate(
        DurableCodexLiveProviderWriteInvocationGateInput {
            boundary: run.boundary.clone(),
            invocation_evidence_refs: vec![format!("evidence:{label}:gate")],
            executor_invocation_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            raw_stream_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        },
    );

    (run, gate)
}
