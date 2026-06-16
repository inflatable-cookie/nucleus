//! Server-owned command runtime readiness envelope vocabulary.
//!
//! These records bind command runner readiness plans to server command ids.
//! They do not implement scheduling, process control, sandboxing, credential
//! lookup, output capture, artifact storage, or event publication.

use nucleus_command_policy::{
    CommandOutputRetention, CommandRequestId, CommandRunnerReadinessPlan,
};

use crate::ids::ServerCommandId;

/// Server envelope for a command runner readiness plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommandRuntimeReadiness {
    pub server_command_id: ServerCommandId,
    pub command_request_id: CommandRequestId,
    pub plan: CommandRunnerReadinessPlan,
    pub server_owned: bool,
}

/// Server-level disposition after readiness evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerCommandRuntimeReadinessDisposition {
    MayQueue,
    Blocked,
    RepairRequired,
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::{
        CommandOutputRetention, CommandRunnerReadinessPlan, CommandRunnerReadinessStatus,
    };

    #[test]
    fn server_command_runtime_readiness_wraps_policy_plan_without_execution() {
        let command_request_id = CommandRequestId("command:ready".to_owned());
        let plan = CommandRunnerReadinessPlan {
            command_request_id: command_request_id.clone(),
            command: None,
            status: CommandRunnerReadinessStatus::Ready,
            surfaces: Vec::new(),
            satisfied_gates: Vec::new(),
            blockers: Vec::new(),
            environment: None,
            output_capture: Some(nucleus_command_policy::CommandOutputCapturePlan {
                retention: CommandOutputRetention::SummaryOnly,
                stdout_artifact_ref: None,
                stderr_artifact_ref: None,
                publish_sanitized_summary: true,
            }),
            interruption: None,
            summary: Some("ready envelope".to_owned()),
        };

        let readiness = ServerCommandRuntimeReadiness {
            server_command_id: ServerCommandId("server-command:ready".to_owned()),
            command_request_id,
            plan,
            server_owned: true,
        };

        assert!(readiness.server_owned);
        assert!(readiness.plan.may_execute());
        assert_eq!(
            readiness.output_retention(),
            Some(CommandOutputRetention::SummaryOnly)
        );
    }
}

impl ServerCommandRuntimeReadiness {
    /// Returns the planned output retention without exposing raw output.
    pub fn output_retention(&self) -> Option<CommandOutputRetention> {
        self.plan
            .output_capture
            .as_ref()
            .map(|capture| capture.retention.clone())
    }
}
