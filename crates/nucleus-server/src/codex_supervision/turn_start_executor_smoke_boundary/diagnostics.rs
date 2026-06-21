use super::types::CodexAppServerTurnStartExecutorSmokeBoundaryInput;

pub(super) fn diagnostics_has_authority(
    input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput,
) -> bool {
    let authority_id = &input.authority.authority_id.0;
    input
        .diagnostics
        .authorities
        .iter()
        .any(|record| &record.authority_id == authority_id)
}

pub(super) fn diagnostics_has_envelope(
    input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput,
) -> bool {
    let envelope_id = &input.envelope.envelope_id.0;
    input
        .diagnostics
        .envelopes
        .iter()
        .any(|record| &record.envelope_id == envelope_id)
}

pub(super) fn diagnostics_has_execution(
    input: &CodexAppServerTurnStartExecutorSmokeBoundaryInput,
) -> bool {
    let execution_id = &input.execution.execution_id;
    input
        .diagnostics
        .executions
        .iter()
        .any(|record| &record.execution_id == execution_id)
}
