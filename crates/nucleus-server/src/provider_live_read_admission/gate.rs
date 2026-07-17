//! The live-read admission stage expressed through the shared gate
//! framework. Blocker discovery and classification stay in `blockers.rs`;
//! this file is the whole gate declaration — the shape new gates should
//! take instead of the stamped multi-file kit.

use crate::admission_gate::AdmissionGate;
use crate::provider_no_effects::ProviderNoEffects;

use super::blockers;
use super::types::{
    ProviderLiveReadAdmissionBlocker, ProviderLiveReadAdmissionInput,
    ProviderLiveReadAdmissionStatus,
};

pub struct ProviderLiveReadAdmissionGate;

/// Gate input: the admission request plus the provider context ref under
/// evaluation.
pub struct ProviderLiveReadGateInput {
    pub input: ProviderLiveReadAdmissionInput,
    pub provider_context_ref: String,
}

impl AdmissionGate for ProviderLiveReadAdmissionGate {
    type Input = ProviderLiveReadGateInput;
    type Blocker = ProviderLiveReadAdmissionBlocker;
    type Status = ProviderLiveReadAdmissionStatus;
    type NoEffects = ProviderNoEffects;

    const GATE_ID: &'static str = "provider-live-read-admission";

    fn blockers(gate_input: &Self::Input) -> Vec<Self::Blocker> {
        blockers::blockers(&gate_input.input, &gate_input.provider_context_ref)
    }

    fn classify(blockers: &[Self::Blocker]) -> Self::Status {
        blockers::status(blockers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission_gate::admit;
    use crate::ForgeNetworkExecutionOperationFamily;

    fn empty_input() -> ProviderLiveReadAdmissionInput {
        ProviderLiveReadAdmissionInput {
            provider_context_refs: Vec::new(),
            provider_instance_ref: None,
            forge_provider: None,
            remote_repo_ref: None,
            operation_family: ForgeNetworkExecutionOperationFamily::StatusCheckRefresh,
            target_refs: Vec::new(),
            credential_status_evidence_refs: Vec::new(),
            network_authority_ref: None,
            payload_policy_ref: None,
            sanitization_policy_ref: None,
            admission_evidence_ref: None,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            provider_write_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        }
    }

    #[test]
    fn framework_gate_matches_family_blocker_and_status_logic() {
        let gate_input = ProviderLiveReadGateInput {
            input: empty_input(),
            provider_context_ref: "context:live-read".to_owned(),
        };
        let outcome = admit::<ProviderLiveReadAdmissionGate>(&gate_input);

        let direct_blockers =
            blockers::blockers(&gate_input.input, &gate_input.provider_context_ref);
        assert_eq!(outcome.blockers, direct_blockers);
        assert_eq!(outcome.status, blockers::status(&direct_blockers));
        assert!(outcome.no_effects.is_none_executed());
        assert_eq!(outcome.gate_id, "provider-live-read-admission");
    }
}
