//! Command envelope and decision vocabulary.

use serde::{Deserialize, Serialize};

/// Stable orchestration command id.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrchestrationCommandId(pub String);

/// Coarse command family known to the orchestration layer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum OrchestrationCommandFamily {
    Project,
    Task,
    Workspace,
    AgentSession,
    Runtime,
    ModelRoute,
    Custom(String),
}

/// Host-independent command admission request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationCommandAdmission {
    pub command_id: OrchestrationCommandId,
    pub family: OrchestrationCommandFamily,
    pub target_ref: Option<String>,
    pub summary: Option<String>,
}

/// Admission decision emitted before command side effects run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrchestrationCommandDecision {
    Accepted(OrchestrationAcceptedCommand),
    Rejected(OrchestrationCommandRejection),
}

/// Accepted command metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationAcceptedCommand {
    pub command_id: OrchestrationCommandId,
    pub family: OrchestrationCommandFamily,
    pub target_ref: Option<String>,
}

/// Rejected command metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrchestrationCommandRejection {
    pub command_id: OrchestrationCommandId,
    pub reason: OrchestrationCommandRejectionReason,
}

/// Admission rejection reason.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrchestrationCommandRejectionReason {
    MissingTargetRef,
    EmptyCommandId,
    UnsupportedFamily,
    Custom(String),
}

/// Minimal command admission service.
#[derive(Clone, Debug, Default)]
pub struct OrchestrationCommandAdmissionService;

impl OrchestrationCommandAdmissionService {
    pub fn new() -> Self {
        Self
    }

    pub fn admit(&self, admission: OrchestrationCommandAdmission) -> OrchestrationCommandDecision {
        if admission.command_id.0.trim().is_empty() {
            return OrchestrationCommandDecision::Rejected(OrchestrationCommandRejection {
                command_id: admission.command_id,
                reason: OrchestrationCommandRejectionReason::EmptyCommandId,
            });
        }

        if requires_target_ref(&admission.family) && admission.target_ref.is_none() {
            return OrchestrationCommandDecision::Rejected(OrchestrationCommandRejection {
                command_id: admission.command_id,
                reason: OrchestrationCommandRejectionReason::MissingTargetRef,
            });
        }

        OrchestrationCommandDecision::Accepted(OrchestrationAcceptedCommand {
            command_id: admission.command_id,
            family: admission.family,
            target_ref: admission.target_ref,
        })
    }
}

fn requires_target_ref(family: &OrchestrationCommandFamily) -> bool {
    matches!(
        family,
        OrchestrationCommandFamily::Project
            | OrchestrationCommandFamily::Task
            | OrchestrationCommandFamily::Workspace
            | OrchestrationCommandFamily::AgentSession
            | OrchestrationCommandFamily::Runtime
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_accepts_task_command_with_target_ref() {
        let service = OrchestrationCommandAdmissionService::new();

        let decision = service.admit(OrchestrationCommandAdmission {
            command_id: OrchestrationCommandId("command:1".to_owned()),
            family: OrchestrationCommandFamily::Task,
            target_ref: Some("task:1".to_owned()),
            summary: Some("start task".to_owned()),
        });

        assert!(matches!(
            decision,
            OrchestrationCommandDecision::Accepted(_)
        ));
    }

    #[test]
    fn admission_rejects_task_command_without_target_ref() {
        let service = OrchestrationCommandAdmissionService::new();

        let decision = service.admit(OrchestrationCommandAdmission {
            command_id: OrchestrationCommandId("command:1".to_owned()),
            family: OrchestrationCommandFamily::Task,
            target_ref: None,
            summary: None,
        });

        assert_eq!(
            decision,
            OrchestrationCommandDecision::Rejected(OrchestrationCommandRejection {
                command_id: OrchestrationCommandId("command:1".to_owned()),
                reason: OrchestrationCommandRejectionReason::MissingTargetRef,
            })
        );
    }
}
