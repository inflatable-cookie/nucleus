use nucleus_command_policy::{CommandExecutionStatus, CommandScope};
use nucleus_contract_fixtures::scenarios::{
    blocked_policy_review_scenario, management_state_sync_scenario, FakeScenarioEvent,
    FakeScenarioStepKind,
};
use nucleus_scm_forge::{ForgeObservationKind, ScmObservationKind};

#[test]
fn management_state_sync_scenario_has_deterministic_order() {
    let scenario = management_state_sync_scenario();

    assert_eq!(scenario.id, "scenario-management-state-sync");
    assert!(scenario.has_strict_ordering());
    assert_eq!(
        scenario.event_sequence(),
        vec![
            FakeScenarioEvent::CommandRequested,
            FakeScenarioEvent::ScmObserved,
            FakeScenarioEvent::TaskLinkProposed,
            FakeScenarioEvent::CommandEvidenceRecorded,
        ]
    );

    let FakeScenarioStepKind::CommandRequest(request) = &scenario.steps[0].kind else {
        panic!("first step should request command authority");
    };
    assert_eq!(request.scope, CommandScope::ManagementStateWrite);

    let FakeScenarioStepKind::CommandEvidence(evidence) = &scenario.steps[3].kind else {
        panic!("last step should record evidence");
    };
    assert_eq!(evidence.status, CommandExecutionStatus::Succeeded);
}

#[test]
fn blocked_policy_review_scenario_keeps_review_and_policy_evidence_ordered() {
    let scenario = blocked_policy_review_scenario();

    assert_eq!(scenario.id, "scenario-blocked-policy-review");
    assert!(scenario.has_strict_ordering());
    assert_eq!(
        scenario.event_sequence(),
        vec![
            FakeScenarioEvent::CommandRequested,
            FakeScenarioEvent::CommandEvidenceRecorded,
            FakeScenarioEvent::ScmObserved,
            FakeScenarioEvent::ForgeObserved,
        ]
    );

    let FakeScenarioStepKind::CommandEvidence(evidence) = &scenario.steps[1].kind else {
        panic!("second step should record command evidence");
    };
    assert_eq!(evidence.status, CommandExecutionStatus::BlockedByPolicy);

    let FakeScenarioStepKind::ScmObservation(observation) = &scenario.steps[2].kind else {
        panic!("third step should be an SCM observation");
    };
    assert!(matches!(
        observation.kind,
        ScmObservationKind::ConflictDetected(_)
    ));

    let FakeScenarioStepKind::ForgeObservation(observation) = &scenario.steps[3].kind else {
        panic!("fourth step should be a forge observation");
    };
    assert!(matches!(
        observation.kind,
        ForgeObservationKind::WebhookRejected(_)
    ));
}
