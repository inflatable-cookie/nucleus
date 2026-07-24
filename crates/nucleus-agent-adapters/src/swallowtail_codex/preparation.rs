use std::time::Duration;

use swallowtail_adapter_codex::{
    prepare_codex, CodexModelSelection, CodexPreparationInput, CodexPreparationProbe,
    CodexPreparedDriver, CodexPreparedIntegration,
};
use swallowtail_core::{
    AccessProfile, AccessProfileId, AccessStatus, ConfiguredInstanceId, CredentialMechanism,
    CredentialState, EndpointAudience, EndpointAuthorization, EntitlementMetering,
    EntitlementState, InstanceRevision, ModelId, ModelRouteId, ModelRouteRevision,
    RuntimeReadiness, SupportAuthority,
};
use swallowtail_runtime::{DiscoveryCancellation, PreparedAccessEvidence};

use super::{host, request_id, scope_id};

const PREPARATION_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn app_server(host: &host::CodexHost) -> Result<CodexPreparedIntegration, String> {
    let services = host.services();
    let time = services
        .time()
        .ok_or_else(|| "Codex preparation time service is unavailable".to_owned())?;
    let input = CodexPreparationInput::new(
        CodexPreparedDriver::AppServer,
        ConfiguredInstanceId::new("nucleus.codex.app-server").map_err(|error| error.to_string())?,
        InstanceRevision::new("1").map_err(|error| error.to_string())?,
        host::host_id(),
        host.target().clone(),
        host.environment().clone(),
        access_profile(),
        PreparedAccessEvidence::caller_asserted(access_status()),
    );
    let probe = CodexPreparationProbe::new(
        request_id("codex-preparation")?,
        scope_id("codex-preparation")?,
        host::deadline_after(time.as_ref(), PREPARATION_TIMEOUT),
        DiscoveryCancellation::new(),
    );
    prepare_codex(input, probe, services).await.map_err(error)
}

pub(super) fn model(model: &str) -> Result<CodexModelSelection, String> {
    Ok(CodexModelSelection::new(
        ModelRouteId::new("nucleus.codex.model-route").map_err(|error| error.to_string())?,
        ModelRouteRevision::new("1").map_err(|error| error.to_string())?,
        ModelId::new(model).map_err(|error| error.to_string())?,
    ))
}

fn access_profile() -> AccessProfile {
    AccessProfile::new(
        access_id(),
        CredentialMechanism::InteractiveOauth,
        EntitlementMetering::SubscriptionAllowance,
        EndpointAudience::new("codex").expect("static audience is valid"),
        SupportAuthority::ProviderSupported,
    )
}

fn access_status() -> AccessStatus {
    AccessStatus::new(
        access_id(),
        CredentialState::Ready,
        EntitlementState::Available,
        EndpointAuthorization::Allowed,
        RuntimeReadiness::Ready,
        SupportAuthority::ProviderSupported,
    )
}

fn access_id() -> AccessProfileId {
    AccessProfileId::new("nucleus.codex.oauth").expect("static access id is valid")
}

pub(super) fn error(error: swallowtail_runtime::PreparationFailure) -> String {
    format!(
        "Codex preparation failed: {} ({})",
        error,
        error.diagnostic().safe().code()
    )
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    use futures_executor::block_on;
    #[cfg(unix)]
    use swallowtail_adapter_codex::{CodexSessionProfileInput, CODEX_CLI_AXIS};
    use swallowtail_core::SupportAuthority;
    #[cfg(unix)]
    use swallowtail_core::{
        ExternalNetworkPolicy, ProviderApprovalPolicy, ReasoningMode, ResourceAccess,
    };
    #[cfg(unix)]
    use swallowtail_runtime::{
        AccessEvidenceProvenance, RequestId, SessionOptions, WorkingResourceRef,
    };

    #[cfg(unix)]
    use super::app_server;
    use super::{access_profile, access_status, model};
    #[cfg(unix)]
    use crate::swallowtail_codex::host;

    #[cfg(unix)]
    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn preparation_keeps_nucleus_owned_access_and_route_identity() {
        let profile = access_profile();
        let status = access_status();
        let model = model("gpt-5.4-mini").expect("model selection");

        assert_eq!(profile.id(), status.profile_id());
        assert_eq!(
            profile.support_authority(),
            SupportAuthority::ProviderSupported
        );
        assert_eq!(
            model,
            swallowtail_adapter_codex::CodexModelSelection::new(
                swallowtail_core::ModelRouteId::new("nucleus.codex.model-route").unwrap(),
                swallowtail_core::ModelRouteRevision::new("1").unwrap(),
                swallowtail_core::ModelId::new("gpt-5.4-mini").unwrap(),
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepared_facade_owns_catalogue_and_session_policy_agreement() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = std::env::temp_dir().join(format!(
            "nucleus-codex-preparation-{}-{}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&fixture, "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n")
            .expect("version fixture");
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o700))
            .expect("fixture permissions");
        let working_directory = std::env::current_dir().expect("working directory");
        let host = host::approved_host(&working_directory, fixture.clone()).expect("approved host");

        let prepared = block_on(app_server(&host)).expect("prepared Codex");
        assert_eq!(
            prepared.observation().version().axis().as_str(),
            CODEX_CLI_AXIS
        );
        assert_eq!(
            prepared.observation().version().version().as_str(),
            "0.145.0"
        );
        assert_eq!(
            prepared.access_evidence().provenance(),
            &AccessEvidenceProvenance::CallerAsserted
        );

        let catalogue = prepared
            .prepare_catalogue(RequestId::new("nucleus-test-catalogue").unwrap(), None)
            .expect("catalogue profile");
        assert_exact_version(catalogue.plan(), "0.145.0");

        let read_only = prepared
            .prepare_read_only_session(CodexSessionProfileInput::new(
                RequestId::new("nucleus-test-read-only").unwrap(),
                model("gpt-5.4-mini").unwrap(),
                WorkingResourceRef::new(host::WORKING_RESOURCE).unwrap(),
                None,
                SessionOptions::default().with_reasoning_mode(ReasoningMode::new("low").unwrap()),
            ))
            .expect("read-only profile");
        assert_exact_version(read_only.plan(), "0.145.0");
        assert_eq!(
            read_only.request().access_policy().resource_access(),
            Some(ResourceAccess::Read)
        );
        assert_eq!(
            read_only.request().access_policy().approval_policy(),
            ProviderApprovalPolicy::Never
        );

        let bounded = prepared
            .prepare_bounded_workspace_session(CodexSessionProfileInput::new(
                RequestId::new("nucleus-test-bounded").unwrap(),
                model("gpt-5.4-mini").unwrap(),
                WorkingResourceRef::new(host::WORKING_RESOURCE).unwrap(),
                None,
                SessionOptions::default().with_reasoning_mode(ReasoningMode::new("low").unwrap()),
            ))
            .expect("bounded profile");
        assert_exact_version(bounded.plan(), "0.145.0");
        assert_eq!(
            bounded.request().access_policy().resource_access(),
            Some(ResourceAccess::ReadWrite)
        );
        assert_eq!(
            bounded.request().access_policy().external_network(),
            ExternalNetworkPolicy::Denied
        );
        assert_eq!(
            bounded.request().access_policy().approval_policy(),
            ProviderApprovalPolicy::Never
        );

        std::fs::remove_file(fixture).expect("fixture cleanup");
    }

    #[cfg(unix)]
    fn assert_exact_version(plan: &swallowtail_core::PreflightPlan, expected: &str) {
        let version = plan
            .interface_versions()
            .find(|binding| binding.axis().as_str() == CODEX_CLI_AXIS)
            .expect("exact Codex version");
        assert_eq!(version.version().as_str(), expected);
        assert!(plan.requirements().interface_versions().any(|binding| {
            binding.axis().as_str() == CODEX_CLI_AXIS && binding.version().as_str() == expected
        }));
    }
}
