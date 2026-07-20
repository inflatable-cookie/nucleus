use swallowtail_adapter_codex::{
    codex_app_server_descriptor, codex_bounded_workspace_access_policy,
    codex_bounded_workspace_capability,
};
use swallowtail_core::{
    preflight, AccessProfile, AccessProfileId, AccessRequirement, AccessStatus, Capability,
    CapabilityConstraint, CapabilityProfile, CapabilityRequirement, ConfiguredInstance,
    ConfiguredInstanceId, CredentialMechanism, CredentialState, DriverRole, EndpointAudience,
    EndpointAuthorization, EntitlementMetering, EntitlementState, ExecutionLayer, HostServiceKind,
    InstanceOwnership, InstancePolicyId, InstanceRevision, InstanceTargetRef, ModelId, ModelRoute,
    ModelRouteId, ModelRouteRevision, OperationRequirements, OperationShape, PreflightContext,
    PreflightPlan, ProtocolFacadeId, ReasoningMode, RuntimeReadiness, SessionAccessPolicy,
    SupportAuthority,
};
use swallowtail_runtime::RuntimeFailure;

use super::host;

pub(super) fn catalog_plan() -> Result<PreflightPlan, RuntimeFailure> {
    plan(DriverRole::ModelCatalog, None, None, 0, 0)
}

pub(super) fn session_plan(
    model: &str,
    reasoning: ReasoningMode,
    tool_count: u32,
    maximum_tool_schema_bytes: u64,
) -> Result<PreflightPlan, RuntimeFailure> {
    interactive_plan(
        model,
        reasoning,
        SessionProfile::ReadOnlyTools {
            tool_count,
            maximum_tool_schema_bytes,
        },
    )
}

pub(super) fn task_session_plan(
    model: &str,
    reasoning: ReasoningMode,
) -> Result<PreflightPlan, RuntimeFailure> {
    interactive_plan(model, reasoning, SessionProfile::BoundedWorkspace)
}

fn plan(
    role: DriverRole,
    model: Option<&str>,
    reasoning: Option<ReasoningMode>,
    tool_count: u32,
    maximum_tool_schema_bytes: u64,
) -> Result<PreflightPlan, RuntimeFailure> {
    let descriptor = codex_app_server_descriptor();
    let access_id = access_id();
    let mut capabilities = vec![CapabilityRequirement::new(
        if role == DriverRole::ModelCatalog {
            Capability::ModelCatalog
        } else {
            Capability::InteractiveSession
        },
        [],
    )];
    if let Some(reasoning) = reasoning {
        capabilities.extend([
            CapabilityRequirement::new(Capability::StreamingEvents, []),
            CapabilityRequirement::new(Capability::Interruption, []),
            CapabilityRequirement::new(
                Capability::ReasoningSelection,
                [CapabilityConstraint::reasoning_mode(reasoning)],
            ),
            CapabilityRequirement::new(
                Capability::ToolCalls,
                [
                    CapabilityConstraint::ToolMaximumCount(tool_count),
                    CapabilityConstraint::ToolMaximumSchemaBytes(maximum_tool_schema_bytes),
                    CapabilityConstraint::tool_schema_dialect("json-schema-2020-12")
                        .map_err(value_failure)?,
                ],
            ),
        ]);
    }
    let profile = CapabilityProfile::new(capabilities.clone());
    let instance = ConfiguredInstance::new(
        ConfiguredInstanceId::new("nucleus.codex.app-server").map_err(value_failure)?,
        InstanceRevision::new("1").map_err(value_failure)?,
        descriptor.identity().id().clone(),
        host::host_id(),
        InstanceTargetRef::new(host::executable_target()).map_err(value_failure)?,
        InstanceOwnership::HostOwnedPersistent,
        access_id.clone(),
        SupportAuthority::ProviderSupported,
        ProtocolFacadeId::new("codex-app-server-v2").map_err(value_failure)?,
        InstancePolicyId::new("nucleus.read-only-no-approval").map_err(value_failure)?,
        profile.clone(),
    );
    let (access, status) = access_state(access_id.clone());
    let host_services = vec![
        HostServiceKind::Task,
        HostServiceKind::Process,
        HostServiceKind::Time,
    ];
    let requirements = OperationRequirements::new(
        ExecutionLayer::HarnessInteraction,
        OperationShape::InteractiveSession,
        role,
        host::host_id(),
        access_requirement(access_id),
    )
    .with_ownership_modes([InstanceOwnership::HostOwnedPersistent])
    .with_host_services(host_services.clone())
    .with_capabilities(capabilities);
    let context = PreflightContext::new(&descriptor, &instance, &access, &status, host_services);
    if let Some(model) = model {
        let route = ModelRoute::new(
            ModelRouteId::new("nucleus.codex.model-route").map_err(value_failure)?,
            ModelRouteRevision::new("1").map_err(value_failure)?,
            instance.id().clone(),
            ModelId::new(model).map_err(value_failure)?,
            profile,
        );
        preflight(
            &context.with_model_route(&route),
            &requirements.require_model_route(),
        )
        .map_err(preflight_failure)
    } else {
        preflight(&context, &requirements).map_err(preflight_failure)
    }
}

enum SessionProfile {
    ReadOnlyTools {
        tool_count: u32,
        maximum_tool_schema_bytes: u64,
    },
    BoundedWorkspace,
}

fn interactive_plan(
    model: &str,
    reasoning: ReasoningMode,
    profile: SessionProfile,
) -> Result<PreflightPlan, RuntimeFailure> {
    let descriptor = codex_app_server_descriptor();
    let access_id = access_id();
    let mut capabilities = vec![
        CapabilityRequirement::new(Capability::InteractiveSession, []),
        CapabilityRequirement::new(Capability::StreamingEvents, []),
        CapabilityRequirement::new(Capability::Interruption, []),
        CapabilityRequirement::new(
            Capability::ReasoningSelection,
            [CapabilityConstraint::reasoning_mode(reasoning)],
        ),
    ];
    let mut host_services = vec![
        HostServiceKind::Task,
        HostServiceKind::Process,
        HostServiceKind::Time,
    ];
    let (policy_id, access_policy, extensions) = match profile {
        SessionProfile::ReadOnlyTools {
            tool_count,
            maximum_tool_schema_bytes,
        } => {
            capabilities.push(CapabilityRequirement::new(
                Capability::ToolCalls,
                [
                    CapabilityConstraint::ToolMaximumCount(tool_count),
                    CapabilityConstraint::ToolMaximumSchemaBytes(maximum_tool_schema_bytes),
                    CapabilityConstraint::tool_schema_dialect("json-schema-2020-12")
                        .map_err(value_failure)?,
                ],
            ));
            (
                "nucleus.read-only-no-approval",
                SessionAccessPolicy::read_only(),
                Vec::new(),
            )
        }
        SessionProfile::BoundedWorkspace => {
            capabilities.push(codex_bounded_workspace_capability());
            host_services.push(HostServiceKind::WorkingResource);
            let policy = codex_bounded_workspace_access_policy();
            let extensions = policy
                .provider_requests()
                .observed_extensions()
                .cloned()
                .collect();
            ("nucleus.bounded-workspace-no-approval", policy, extensions)
        }
    };
    let capability_profile = CapabilityProfile::new(capabilities.clone());
    let instance = ConfiguredInstance::new(
        ConfiguredInstanceId::new("nucleus.codex.app-server").map_err(value_failure)?,
        InstanceRevision::new("1").map_err(value_failure)?,
        descriptor.identity().id().clone(),
        host::host_id(),
        InstanceTargetRef::new(host::executable_target()).map_err(value_failure)?,
        InstanceOwnership::HostOwnedPersistent,
        access_id.clone(),
        SupportAuthority::ProviderSupported,
        ProtocolFacadeId::new("codex-app-server-v2").map_err(value_failure)?,
        InstancePolicyId::new(policy_id).map_err(value_failure)?,
        capability_profile.clone(),
    );
    let route = ModelRoute::new(
        ModelRouteId::new("nucleus.codex.model-route").map_err(value_failure)?,
        ModelRouteRevision::new("1").map_err(value_failure)?,
        instance.id().clone(),
        ModelId::new(model).map_err(value_failure)?,
        capability_profile,
    );
    let (access, status) = access_state(access_id.clone());
    let requirements = OperationRequirements::new(
        ExecutionLayer::HarnessInteraction,
        OperationShape::InteractiveSession,
        DriverRole::InteractiveSession,
        host::host_id(),
        access_requirement(access_id),
    )
    .with_ownership_modes([InstanceOwnership::HostOwnedPersistent])
    .with_host_services(host_services.clone())
    .with_capabilities(capabilities)
    .with_extension_namespaces(extensions)
    .with_session_access_policy(access_policy)
    .require_model_route();
    preflight(
        &PreflightContext::new(&descriptor, &instance, &access, &status, host_services)
            .with_model_route(&route),
        &requirements,
    )
    .map_err(preflight_failure)
}

fn access_state(id: AccessProfileId) -> (AccessProfile, AccessStatus) {
    (
        AccessProfile::new(
            id.clone(),
            CredentialMechanism::InteractiveOauth,
            EntitlementMetering::SubscriptionAllowance,
            EndpointAudience::new("codex").expect("static audience is valid"),
            SupportAuthority::ProviderSupported,
        ),
        AccessStatus::new(
            id,
            CredentialState::Ready,
            EntitlementState::Available,
            EndpointAuthorization::Allowed,
            RuntimeReadiness::Ready,
            SupportAuthority::ProviderSupported,
        ),
    )
}

fn access_requirement(id: AccessProfileId) -> AccessRequirement {
    AccessRequirement::new(id)
        .with_credential_states([CredentialState::Ready])
        .with_entitlement_states([EntitlementState::Available])
        .with_endpoint_authorizations([EndpointAuthorization::Allowed])
        .with_runtime_readiness([RuntimeReadiness::Ready])
        .with_support_authorities([SupportAuthority::ProviderSupported])
}

fn access_id() -> AccessProfileId {
    AccessProfileId::new("nucleus.codex.oauth").expect("static access id is valid")
}

fn value_failure(error: impl ToString) -> RuntimeFailure {
    host::safe_failure(error.to_string())
}

fn preflight_failure(error: impl ToString) -> RuntimeFailure {
    host::safe_failure(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use swallowtail_core::{
        ExternalNetworkPolicy, ExternalSearchPolicy, ProviderApprovalPolicy, ResourceAccess,
    };

    #[test]
    fn task_plan_binds_the_bounded_profile_without_product_tools() {
        let plan = task_session_plan(
            "gpt-5.4-mini",
            ReasoningMode::new("low").expect("reasoning mode"),
        )
        .expect("task plan");
        let requirements = plan.requirements();
        let policy = requirements
            .session_access_policy()
            .expect("session policy");

        assert_eq!(policy.resource_access(), ResourceAccess::ReadWrite);
        assert_eq!(policy.approval_policy(), ProviderApprovalPolicy::Never);
        assert_eq!(policy.external_network(), ExternalNetworkPolicy::Denied);
        assert_eq!(policy.external_search(), ExternalSearchPolicy::Disabled);
        assert!(requirements
            .host_services()
            .any(|service| service == HostServiceKind::WorkingResource));
        assert!(requirements
            .capabilities()
            .any(|requirement| requirement.capability() == Capability::WorkingResource));
        assert!(!requirements
            .capabilities()
            .any(|requirement| requirement.capability() == Capability::ToolCalls));
        assert_eq!(requirements.extension_namespaces().len(), 2);
    }
}
