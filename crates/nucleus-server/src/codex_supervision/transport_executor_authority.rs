//! Codex transport executor authority records.
//!
//! These records decide whether a Codex `turn/start` transport execution
//! handoff may be prepared. They do not write to Codex stdio, retain raw
//! payloads or streams, schedule retries, or mutate task state.

use crate::host_authority::{EngineHostId, HostAuthorityReadiness, HostAuthorityReadinessStatus};
use crate::provider_service_runtime::ProviderServiceId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteAttemptStatus,
};

use super::live_send_preflight::{
    CodexAppServerLiveSendPreflightRecord, CodexAppServerLiveSendPreflightStatus,
};

/// Stable id for one Codex transport executor authority record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityId(pub String);

/// Input for assessing Codex transport executor authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityInput {
    pub preflight: CodexAppServerLiveSendPreflightRecord,
    pub write_attempt: ProviderTransportWriteAttemptRecord,
    pub execution_host_authority: HostAuthorityReadiness,
    pub provider_instance: CodexAppServerTransportExecutorProviderAuthority,
    pub operator_confirmation: CodexAppServerTransportExecutorOperatorConfirmation,
    pub raw_payload_policy_confirmed: bool,
    pub raw_stream_policy_confirmed: bool,
    pub task_mutation_requested: bool,
}

/// Provider instance authority evidence for the transport executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorProviderAuthority {
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub auth_readiness: CodexAppServerTransportExecutorEvidenceState,
    pub transport_readiness: CodexAppServerTransportExecutorEvidenceState,
    pub evidence_refs: Vec<String>,
}

/// Evidence state for one executor-authority dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorEvidenceState {
    Ready { evidence_ref: String },
    Missing,
    Stale { evidence_ref: String },
    Blocked { reason: String },
}

/// Operator confirmation for the transport executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorOperatorConfirmation {
    Missing,
    Confirmed {
        operator_ref: String,
        evidence_ref: String,
        scope: CodexAppServerTransportExecutorConfirmationScope,
    },
}

/// Scope of an operator confirmation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorConfirmationScope {
    PrepareExecutionHandoffOnly,
    RealProviderWriteSmoke,
}

/// Authority decision for Codex transport executor handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTransportExecutorAuthorityRecord {
    pub authority_id: CodexAppServerTransportExecutorAuthorityId,
    pub execution_host_id: EngineHostId,
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub preflight_id: String,
    pub write_attempt_id: String,
    pub status: CodexAppServerTransportExecutorAuthorityStatus,
    pub blockers: Vec<CodexAppServerTransportExecutorAuthorityBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Transport executor authority status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorAuthorityStatus {
    ReadyForExecutionHandoff,
    Blocked,
}

/// Why Codex transport execution cannot be handed off.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportExecutorAuthorityBlocker {
    ExecutionHostAuthorityNotReady(HostAuthorityReadinessStatus),
    ProviderServiceMissing,
    ProviderServiceMismatch,
    MissingProviderAuthReadiness,
    StaleProviderAuthReadiness,
    ProviderAuthBlocked(String),
    MissingTransportReadiness,
    StaleTransportReadiness,
    TransportReadinessBlocked(String),
    OperatorConfirmationMissing,
    PreflightNotAccepted,
    TransportWriteNotQueued,
    RawPayloadPolicyUnconfirmed,
    RawStreamPolicyUnconfirmed,
    TaskMutationRequested,
    ProviderWriteAlreadyExecuted,
}

/// Assess Codex transport executor authority without executing provider I/O.
pub fn codex_transport_executor_authority(
    input: CodexAppServerTransportExecutorAuthorityInput,
) -> CodexAppServerTransportExecutorAuthorityRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    if input.execution_host_authority.status != HostAuthorityReadinessStatus::Ready {
        blockers.push(
            CodexAppServerTransportExecutorAuthorityBlocker::ExecutionHostAuthorityNotReady(
                input.execution_host_authority.status.clone(),
            ),
        );
    }
    match &input.provider_instance.service_id {
        None => {
            blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderServiceMissing)
        }
        Some(service_id) if service_id != &input.write_attempt.service_id => {
            blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderServiceMismatch);
        }
        Some(_) => {}
    }

    collect_executor_evidence(
        &input.provider_instance.auth_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerTransportExecutorAuthorityBlocker::MissingProviderAuthReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::StaleProviderAuthReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::ProviderAuthBlocked,
    );
    collect_executor_evidence(
        &input.provider_instance.transport_readiness,
        &mut evidence_refs,
        &mut blockers,
        CodexAppServerTransportExecutorAuthorityBlocker::MissingTransportReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::StaleTransportReadiness,
        CodexAppServerTransportExecutorAuthorityBlocker::TransportReadinessBlocked,
    );

    match input.operator_confirmation {
        CodexAppServerTransportExecutorOperatorConfirmation::Missing => blockers
            .push(CodexAppServerTransportExecutorAuthorityBlocker::OperatorConfirmationMissing),
        CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
            operator_ref,
            evidence_ref,
            scope,
        } => {
            evidence_refs.push(format!("operator:{operator_ref}"));
            evidence_refs.push(format!("operator-confirmation:{scope:?}"));
            evidence_refs.push(evidence_ref);
        }
    }
    if input.preflight.status != CodexAppServerLiveSendPreflightStatus::AcceptedForTransportAttempt
    {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::PreflightNotAccepted);
    }
    if input.write_attempt.status != ProviderTransportWriteAttemptStatus::Queued {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::TransportWriteNotQueued);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::RawPayloadPolicyUnconfirmed);
    }
    if !input.raw_stream_policy_confirmed {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::RawStreamPolicyUnconfirmed);
    }
    if input.task_mutation_requested {
        blockers.push(CodexAppServerTransportExecutorAuthorityBlocker::TaskMutationRequested);
    }
    if input.write_attempt.provider_write_executed {
        blockers
            .push(CodexAppServerTransportExecutorAuthorityBlocker::ProviderWriteAlreadyExecuted);
    }

    evidence_refs.extend(input.preflight.evidence_refs.iter().cloned());
    evidence_refs.extend(input.write_attempt.evidence_refs.iter().cloned());
    evidence_refs.extend(input.provider_instance.evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff
    } else {
        CodexAppServerTransportExecutorAuthorityStatus::Blocked
    };

    CodexAppServerTransportExecutorAuthorityRecord {
        authority_id: CodexAppServerTransportExecutorAuthorityId(format!(
            "codex-transport-executor-authority:{}",
            input.write_attempt.attempt_id.0
        )),
        execution_host_id: input.execution_host_authority.host_id,
        provider_instance_id: input.provider_instance.provider_instance_id,
        service_id: input.provider_instance.service_id,
        preflight_id: input.preflight.preflight_id.0,
        write_attempt_id: input.write_attempt.attempt_id.0,
        status,
        blockers,
        evidence_refs,
        provider_write_executed: false,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

fn collect_executor_evidence(
    state: &CodexAppServerTransportExecutorEvidenceState,
    evidence_refs: &mut Vec<String>,
    blockers: &mut Vec<CodexAppServerTransportExecutorAuthorityBlocker>,
    missing: CodexAppServerTransportExecutorAuthorityBlocker,
    stale: CodexAppServerTransportExecutorAuthorityBlocker,
    blocked: fn(String) -> CodexAppServerTransportExecutorAuthorityBlocker,
) {
    match state {
        CodexAppServerTransportExecutorEvidenceState::Ready { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
        }
        CodexAppServerTransportExecutorEvidenceState::Missing => blockers.push(missing),
        CodexAppServerTransportExecutorEvidenceState::Stale { evidence_ref } => {
            evidence_refs.push(evidence_ref.clone());
            blockers.push(stale);
        }
        CodexAppServerTransportExecutorEvidenceState::Blocked { reason } => {
            blockers.push(blocked(reason.clone()));
        }
    }
}

#[cfg(test)]
mod tests;
