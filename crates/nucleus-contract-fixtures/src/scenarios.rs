//! Dev-only fake adapter scenario scripts.
//!
//! Scenario scripts are ordered test fixtures. They are not production runtime
//! events, replay logs, persistence records, or adapter traits.

use nucleus_command_policy::{CommandEvidence, CommandExecutionRequest};
use nucleus_scm_forge::{ForgeObservation, ScmObservation, ScmTaskLink};

use crate::fake_adapters::{FakeCommandPolicyAdapter, FakeForgeAdapter, FakeScmAdapter};

/// Ordered fake adapter scenario.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeAdapterScenario {
    pub id: String,
    pub steps: Vec<FakeScenarioStep>,
}

/// One ordered step in a fake adapter scenario.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeScenarioStep {
    pub ordinal: u32,
    pub label: String,
    pub kind: FakeScenarioStepKind,
}

/// Scenario step kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FakeScenarioStepKind {
    CommandRequest(CommandExecutionRequest),
    CommandEvidence(CommandEvidence),
    ScmObservation(ScmObservation),
    ForgeObservation(ForgeObservation),
    TaskLink(ScmTaskLink),
}

/// Scenario event categories for tests that only need coarse ordering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FakeScenarioEvent {
    CommandRequested,
    CommandEvidenceRecorded,
    ScmObserved,
    ForgeObserved,
    TaskLinkProposed,
}

impl FakeAdapterScenario {
    /// Coarse event sequence derived from the script.
    pub fn event_sequence(&self) -> Vec<FakeScenarioEvent> {
        self.steps
            .iter()
            .map(|step| match step.kind {
                FakeScenarioStepKind::CommandRequest(_) => FakeScenarioEvent::CommandRequested,
                FakeScenarioStepKind::CommandEvidence(_) => {
                    FakeScenarioEvent::CommandEvidenceRecorded
                }
                FakeScenarioStepKind::ScmObservation(_) => FakeScenarioEvent::ScmObserved,
                FakeScenarioStepKind::ForgeObservation(_) => FakeScenarioEvent::ForgeObserved,
                FakeScenarioStepKind::TaskLink(_) => FakeScenarioEvent::TaskLinkProposed,
            })
            .collect()
    }

    /// Returns true when step ordinals are strictly increasing.
    pub fn has_strict_ordering(&self) -> bool {
        self.steps
            .windows(2)
            .all(|pair| pair[0].ordinal < pair[1].ordinal)
    }
}

/// Management-state sync path with command, SCM observation, task link, and summary evidence.
pub fn management_state_sync_scenario() -> FakeAdapterScenario {
    let commands = FakeCommandPolicyAdapter::provider_neutral();
    let scm = FakeScmAdapter::convergence_like();

    FakeAdapterScenario {
        id: "scenario-management-state-sync".to_owned(),
        steps: vec![
            FakeScenarioStep {
                ordinal: 1,
                label: "request management-state write".to_owned(),
                kind: FakeScenarioStepKind::CommandRequest(commands.requests()[1].clone()),
            },
            FakeScenarioStep {
                ordinal: 2,
                label: "observe repository".to_owned(),
                kind: FakeScenarioStepKind::ScmObservation(scm.observations()[0].clone()),
            },
            FakeScenarioStep {
                ordinal: 3,
                label: "propose task link".to_owned(),
                kind: FakeScenarioStepKind::TaskLink(scm.task_links()[0].clone()),
            },
            FakeScenarioStep {
                ordinal: 4,
                label: "record summary evidence".to_owned(),
                kind: FakeScenarioStepKind::CommandEvidence(commands.evidence()[0].clone()),
            },
        ],
    }
}

/// Blocked-policy and rejected-review path with command, SCM, and forge evidence.
pub fn blocked_policy_review_scenario() -> FakeAdapterScenario {
    let commands = FakeCommandPolicyAdapter::provider_neutral();
    let scm = FakeScmAdapter::convergence_like();
    let forge = FakeForgeAdapter::generic();

    FakeAdapterScenario {
        id: "scenario-blocked-policy-review".to_owned(),
        steps: vec![
            FakeScenarioStep {
                ordinal: 1,
                label: "request destructive command".to_owned(),
                kind: FakeScenarioStepKind::CommandRequest(commands.requests()[4].clone()),
            },
            FakeScenarioStep {
                ordinal: 2,
                label: "record blocked policy evidence".to_owned(),
                kind: FakeScenarioStepKind::CommandEvidence(commands.evidence()[2].clone()),
            },
            FakeScenarioStep {
                ordinal: 3,
                label: "observe SCM conflict".to_owned(),
                kind: FakeScenarioStepKind::ScmObservation(scm.observations()[2].clone()),
            },
            FakeScenarioStep {
                ordinal: 4,
                label: "observe rejected webhook".to_owned(),
                kind: FakeScenarioStepKind::ForgeObservation(forge.observations()[2].clone()),
            },
        ],
    }
}
