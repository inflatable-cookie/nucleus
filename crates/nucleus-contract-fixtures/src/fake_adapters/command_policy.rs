//! Dev-only command-policy fake adapter surface.

use nucleus_command_policy::{CommandEvidence, CommandExecutionRequest};

use crate::command_policy::{
    artifact_ref_failure_evidence, blocked_by_policy_evidence, destructive_blocked_request,
    management_state_write_request, network_access_request, read_only_inspection_request,
    secret_access_blocked_request, source_code_write_request, summary_only_success_evidence,
    timed_out_evidence,
};

/// Deterministic command-policy fake for contract tests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeCommandPolicyAdapter {
    requests: Vec<CommandExecutionRequest>,
    evidence: Vec<CommandEvidence>,
}

impl FakeCommandPolicyAdapter {
    /// Returns a provider-neutral command-policy fixture surface.
    pub fn provider_neutral() -> Self {
        Self {
            requests: vec![
                read_only_inspection_request(),
                management_state_write_request(),
                source_code_write_request(),
                network_access_request(),
                destructive_blocked_request(),
                secret_access_blocked_request(),
            ],
            evidence: vec![
                summary_only_success_evidence(),
                artifact_ref_failure_evidence(),
                blocked_by_policy_evidence(),
                timed_out_evidence(),
            ],
        }
    }

    /// Scripted command authority requests.
    pub fn requests(&self) -> &[CommandExecutionRequest] {
        &self.requests
    }

    /// Scripted sanitized command evidence.
    pub fn evidence(&self) -> &[CommandEvidence] {
        &self.evidence
    }
}
