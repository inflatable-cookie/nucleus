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

#[test]
fn product_workflow_proof_panel_has_no_forbidden_mutation_controls() {
    let component = include_str!("../../../src/lib/ProductWorkflowProofPanel.svelte");

    for forbidden in [
        "buildStartTaskCommand",
        "buildBlockTaskCommand",
        "buildCompleteTaskCommand",
        "buildArchiveTaskCommand",
        "submitControlEnvelope",
        "approve",
        "apply button",
        "apply import",
        "create task",
        "browser automation",
        "source retrieval",
        "merge",
        "commit",
        "push",
        "pull request",
        "panel layout",
        "plugin runtime",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "product workflow proof panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryProductWorkflowSummary"));
    assert!(component.contains("Read-only workflow."));
}

#[test]
fn task_workflow_drilldown_proof_panel_allows_only_task_command_admission_controls() {
    let component = include_str!("../../../src/lib/TaskWorkflowDrilldownProofPanel.svelte");

    for forbidden in [
        "approve button",
        "run task command",
        "run provider",
        "execute provider",
        "schedule delegation",
        "delegate task",
        "create task",
        "browser automation",
        "source retrieval",
        "merge",
        "commit button",
        "push button",
        "pull request",
        "review acceptance",
        "active apply",
        "final design",
        "raw_request_body",
        "raw_response_body",
        "provider payload",
        "provider output",
    ] {
        assert!(
            !component.to_lowercase().contains(&forbidden.to_lowercase()),
            "task workflow drilldown proof panel should not expose {forbidden}"
        );
    }
    assert!(component.contains("queryTaskWorkflowDrilldown"));
    assert!(component.contains("queryProductWorkflowSummary"));
    assert!(component.contains("querySelectedTaskActionReadiness"));
    assert!(component.contains("querySelectedTaskOperatorActionGate"));
    assert!(component.contains("querySelectedTaskReviewNext"));
    assert!(component.contains("querySelectedTaskReviewOutcomeRoute"));
    assert!(component.contains("querySelectedTaskReviewDecisionAdmission"));
    assert!(component.contains("querySelectedTaskReviewDecisionApply"));
    assert!(component.contains("querySelectedTaskScmHandoff"));
    assert!(component.contains("querySelectedTaskCommandAdmission"));
    assert!(component.contains("submitSelectedTaskCommand"));
    assert!(component.contains("onTaskCommandChanged?.()"));
    assert!(component.contains("awaitingTaskRefresh = true"));
    assert!(component.contains("lastCommandRevision = submittedRevision"));
    assert!(component.contains("selectedTask.revision_id !== lastCommandRevision"));
    assert!(component.contains("waitingForServerTaskRecord"));
    assert!(component.contains("blockReason = \"\""));
    assert!(component.contains("type CommandReceiptSummary"));
    assert!(component.contains("commandReceipt = {"));
    assert!(component.contains("Task command outcome evidence"));
    assert!(component.contains("Command receipt"));
    assert!(component.contains("Refreshed timeline evidence"));
    assert!(component.contains("Task command timeline refs"));
    assert!(component.contains("drilldown?.timeline.entry_refs"));
    assert!(component.contains("drilldown.source_counts.timeline_entry_refs"));
    assert!(!component.contains("selectedTask.activity ="));
    assert!(!component.contains("selectedTask.revision_id = \""));
    assert!(!component.contains("selectedTask.revision_id = null"));
    assert!(component.contains("Work-loop guidance"));
    assert!(component.contains("Selected task action readiness"));
    assert!(component.contains("Selected task operator action gate"));
    assert!(component.contains("Selected task command admission"));
    assert!(component.contains("Task command candidates"));
    assert!(component.contains("Deferred and read-only actions"));
    assert!(component.contains("Allowed action affordances"));
    assert!(component.contains("Blocked action affordances"));
    assert!(component.contains("Guidance missing evidence"));
    assert!(component.contains("Review readiness"));
    assert!(component.contains("Handoff readiness"));
    assert!(component.contains("Selected task review next"));
    assert!(component.contains("Review evidence boundary"));
    assert!(component.contains("Pathway-backed next step"));
    assert!(component.contains("Review gaps"));
    assert!(component.contains("reviewNext.no_effects.review_mutation_performed"));
    assert!(component.contains("Review decision controls"));
    assert!(component.contains("Preview decisions"));
    assert!(component.contains("submitReviewDecision"));
    assert!(component.contains("reviewDecisionCanApply"));
    assert!(component.contains("reviewDecisionAdmissions[action]"));
    assert!(component.contains("reviewDecisionApplyResult.status"));
    assert!(component.contains("reviewDecisionApplyResult.blockers"));
    assert!(component.contains("reviewDecisionApplyResult.review_mutation_performed"));
    assert!(component.contains("reviewDecisionApplyResult.task_lifecycle_mutation_performed"));
    assert!(component.contains("reviewDecisionApplyResult.provider_execution_performed"));
    assert!(component.contains("reviewDecisionApplyResult.scm_or_forge_mutation_performed"));
    assert!(component.contains("Selected task review outcome route"));
    assert!(component.contains("Review outcome route"));
    assert!(component.contains("Route candidates"));
    assert!(component.contains("Downstream hints"));
    assert!(component.contains("Route blockers"));
    assert!(component.contains("reviewOutcomeRoute.source_counts.decision_records"));
    assert!(component.contains("reviewOutcomeRoute.source_counts.downstream_command_hints"));
    assert!(component.contains("reviewOutcomeRoute.no_effects.task_lifecycle_mutation_performed"));
    assert!(component.contains("reviewOutcomeRoute.no_effects.provider_execution_performed"));
    assert!(component.contains("reviewOutcomeRoute.no_effects.scm_or_forge_mutation_performed"));
    assert!(component.contains("reviewOutcomeRoute.no_effects.ui_effect_performed"));
    assert!(component.contains("Selected task SCM handoff readiness"));
    assert!(component.contains("SCM handoff readiness"));
    assert!(component.contains("Target shape"));
    assert!(component.contains("Handoff evidence boundary"));
    assert!(component.contains("Handoff next step"));
    assert!(component.contains("Handoff blockers"));
    assert!(component.contains("scmHandoff.no_effects.scm_mutation_performed"));
    assert!(component.contains("scmHandoff.no_effects.forge_mutation_performed"));
    assert!(component.contains("scmHandoff.no_effects.credential_resolution_performed"));
    assert!(component.contains("Block reason"));
    assert!(component.contains("buildStartTaskCommand"));
    assert!(component.contains("buildBlockTaskCommand"));
    assert!(component.contains("buildCompleteTaskCommand"));
    assert!(component.contains("buildArchiveTaskCommand"));
}

#[test]
fn app_shell_routes_task_command_refresh_to_task_list_token() {
    let component = include_str!("../../../src/App.svelte");

    assert!(component.contains("let taskRefreshToken = $state(0);"));
    assert!(component.contains("<TaskListPanel"));
    assert!(component.contains("{taskRefreshToken}"));
    assert!(component.contains("onTaskCommandChanged"));
    assert!(component.contains("taskRefreshToken += 1"));
    assert!(!component.contains("selectedTask = {"));
    assert!(!component.contains("selectedTask.activity ="));
}
