//! Compile-only command runtime effect trait skeletons.
//!
//! These traits describe command effect request acceptance and sanitized
//! evidence outcome reporting only. They do not execute commands, spawn
//! processes, open terminals, stream output, implement sandboxes, retain
//! artifacts, schedule retries, or persist replay state.

use crate::authority::CommandAuthorityReadiness;
use crate::effects::{CommandEffectOutcome, CommandEffectRequest, CommandEffectRequestId};

/// Command runtime effect request acceptance surface.
pub trait CommandRuntimeEffectAcceptanceSurface {
    fn runtime_readiness(&self) -> CommandAuthorityReadiness;
    fn accept_command_effect(&self, request: &CommandEffectRequest) -> CommandEffectOutcome;
}

/// Command runtime effect outcome reporting surface.
pub trait CommandRuntimeEffectOutcomeSurface {
    fn command_effect_outcome(
        &self,
        request_id: &CommandEffectRequestId,
    ) -> Option<CommandEffectOutcome>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{
        CommandEffectCancellation, CommandEffectOutcomeKind, CommandEffectRequestKind,
        CommandEffectRetry,
    };
    use crate::evidence::{CommandEvidence, CommandExecutionStatus, CommandOutputRetention};
    use crate::ids::{CommandEvidenceId, CommandRequestId};

    struct StaticCommandRuntimeEffectSurface {
        outcome: CommandEffectOutcome,
    }

    impl CommandRuntimeEffectAcceptanceSurface for StaticCommandRuntimeEffectSurface {
        fn runtime_readiness(&self) -> CommandAuthorityReadiness {
            CommandAuthorityReadiness::Ready
        }

        fn accept_command_effect(&self, request: &CommandEffectRequest) -> CommandEffectOutcome {
            CommandEffectOutcome {
                request_id: request.id.clone(),
                command_request_id: request.command_request_id.clone(),
                kind: CommandEffectOutcomeKind::Queued,
                retry: CommandEffectRetry::NotRetryable,
                summary: Some("queued without execution".to_owned()),
            }
        }
    }

    impl CommandRuntimeEffectOutcomeSurface for StaticCommandRuntimeEffectSurface {
        fn command_effect_outcome(
            &self,
            request_id: &CommandEffectRequestId,
        ) -> Option<CommandEffectOutcome> {
            (self.outcome.request_id == *request_id).then(|| self.outcome.clone())
        }
    }

    #[test]
    fn command_runtime_effect_traits_separate_acceptance_from_evidence_outcome() {
        let command_request_id = CommandRequestId("command:runtime".to_owned());
        let effect_request_id = CommandEffectRequestId("effect:command-runtime".to_owned());
        let evidence = CommandEvidence {
            id: CommandEvidenceId("evidence:cancelled".to_owned()),
            request_id: command_request_id.clone(),
            status: CommandExecutionStatus::Cancelled,
            exit_status: None,
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("cancelled before process start".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        };
        let surface = StaticCommandRuntimeEffectSurface {
            outcome: CommandEffectOutcome {
                request_id: effect_request_id.clone(),
                command_request_id: command_request_id.clone(),
                kind: CommandEffectOutcomeKind::Cancelled(evidence),
                retry: CommandEffectRetry::Cancelled,
                summary: None,
            },
        };
        let request = CommandEffectRequest {
            id: effect_request_id.clone(),
            command_request_id,
            kind: CommandEffectRequestKind::QueueForExecution,
            command: None,
            cancellation: CommandEffectCancellation::Requested,
        };

        let accepted = surface.accept_command_effect(&request);
        let reported = surface.command_effect_outcome(&effect_request_id);

        assert_eq!(
            surface.runtime_readiness(),
            CommandAuthorityReadiness::Ready
        );
        assert!(matches!(accepted.kind, CommandEffectOutcomeKind::Queued));
        assert!(matches!(
            reported.map(|outcome| outcome.kind),
            Some(CommandEffectOutcomeKind::Cancelled(_))
        ));
    }
}
