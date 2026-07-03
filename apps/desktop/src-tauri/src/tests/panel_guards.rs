#[test]
fn command_diagnostics_panel_has_no_forbidden_command_controls() {
    let component = include_str!("../../../src/lib/CommandDiagnosticsPanel.svelte");

    for forbidden in [
        "buildStartTaskCommand",
        "buildBlockTaskCommand",
        "buildCompleteTaskCommand",
        "buildArchiveTaskCommand",
        "submitControlEnvelope",
        "approve",
        "cancel",
        "retry",
        "download",
        "pty",
        "stream",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "command diagnostics panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryCommandHistory"));
    assert!(component.contains("No execution controls."));
}

#[test]
fn runtime_readiness_panel_has_no_forbidden_runtime_controls() {
    let component = include_str!("../../../src/lib/RuntimeReadinessPanel.svelte");

    for forbidden in [
        "buildStartTaskCommand",
        "buildBlockTaskCommand",
        "buildCompleteTaskCommand",
        "buildArchiveTaskCommand",
        "submitControlEnvelope",
        "approve",
        "cancel",
        "retry",
        "execute",
        "repair runtime",
        "runtime repair",
        "repair control",
        "download",
        "pty",
        "stream",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "runtime readiness panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryRuntimeReadiness"));
    assert!(component.contains("Read-only diagnostics."));
}

#[test]
fn provider_readiness_panel_has_no_forbidden_provider_controls() {
    let component = include_str!("../../../src/lib/ProviderReadinessOverviewPanel.svelte");

    for forbidden in [
        "buildStartTaskCommand",
        "buildBlockTaskCommand",
        "buildCompleteTaskCommand",
        "buildArchiveTaskCommand",
        "submitControlEnvelope",
        "approve",
        "cancel",
        "retry",
        "provider refresh",
        "credential repair",
        "resolve credential",
        "provider write",
        "create pull request",
        "merge",
        "raw_response_body",
        "raw_request_body",
        "access_token",
        "authorization",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "provider readiness panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryProviderReadinessOverview"));
    assert!(component.contains("queryProviderReadIntent"));
    assert!(component.contains("Read-intent drilldown"));
    assert!(component.contains("Source counts"));
    assert!(component.contains("No provider controls."));
}

#[test]
fn planning_research_proof_panel_has_no_forbidden_mutation_controls() {
    let component = include_str!("../../../src/lib/PlanningResearchProofPanel.svelte");

    for forbidden in [
        "buildStartTaskCommand",
        "buildBlockTaskCommand",
        "buildCompleteTaskCommand",
        "buildArchiveTaskCommand",
        "submitControlEnvelope",
        "approve",
        "apply",
        "execute",
        "promote",
        "create task",
        "provider write",
        "browser automation",
        "source retrieval",
        "merge",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "planning proof panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryPlanningSessions"));
    assert!(component.contains("queryMemoryProposals"));
    assert!(component.contains("queryResearchRunBriefs"));
    assert!(component.contains("Read-only inspection."));
}
