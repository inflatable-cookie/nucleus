//! Non-spawning process supervisor acceptance skeleton.
//!
//! This module accepts or rejects process supervision requests after host
//! authority and readiness checks. It does not spawn child processes, open
//! PTYs, capture output, persist artifacts, or publish events.

use nucleus_command_policy::{
    CommandEvidenceRef, CommandPolicyDecisionRef, CommandProcessSupervisionBlocker,
    CommandProcessSupervisionEventId, CommandProcessSupervisionEventKind,
    CommandProcessSupervisionEventPayload, CommandProcessSupervisionReadiness,
    CommandProcessSupervisionReadinessStatus, CommandProcessSupervisionStatus, CommandRequestId,
};
use nucleus_projects::ProjectId;

use crate::host_authority::{
    EngineHostId, HostAuthorityReadinessStatus, ProjectAuthorityDomain, ProjectAuthorityMap,
};
use crate::ids::ServerEventId;
use crate::process_supervision_events::ProcessSupervisionServerEvent;
use crate::runtime_effect_events::ServerEventSequence;

/// Request to accept process supervision work for one command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSupervisorAcceptanceRequest {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub authority_map: ProjectAuthorityMap,
    pub readiness: CommandProcessSupervisionReadiness,
    pub evidence_ref: Option<CommandEvidenceRef>,
    pub policy_decision_ref: Option<CommandPolicyDecisionRef>,
    pub first_sequence: ServerEventSequence,
    pub summary: Option<String>,
}

/// Result of process supervisor acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessSupervisorAcceptanceDecision {
    Accepted(ProcessSupervisorAcceptedEvents),
    Rejected(ProcessSupervisorAcceptanceRejection),
}

/// Accepted supervision event pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSupervisorAcceptedEvents {
    pub accepted: ProcessSupervisionServerEvent,
    pub queued: ProcessSupervisionServerEvent,
}

/// Rejected supervision request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSupervisorAcceptanceRejection {
    pub reason: ProcessSupervisorAcceptanceRejectionReason,
    pub blockers: Vec<CommandProcessSupervisionBlocker>,
    pub event: ProcessSupervisionServerEvent,
}

/// Reason a supervision request was rejected before any process could start.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessSupervisorAcceptanceRejectionReason {
    ProjectAuthorityMismatch,
    MissingExecutionAuthority(HostAuthorityReadinessStatus),
    ReadinessBlocked(CommandProcessSupervisionReadinessStatus),
}

/// Accept or reject a process supervision request without spawning.
pub fn accept_process_supervision_request(
    request: ProcessSupervisorAcceptanceRequest,
) -> ProcessSupervisorAcceptanceDecision {
    if request.authority_map.project_id != request.project_id {
        return rejected(
            &request,
            ProcessSupervisorAcceptanceRejectionReason::ProjectAuthorityMismatch,
            Vec::new(),
        );
    }

    let authority = request.authority_map.readiness_for(
        &request.execution_host_id,
        &ProjectAuthorityDomain::Execution,
    );
    if !authority.is_ready() {
        return rejected(
            &request,
            ProcessSupervisorAcceptanceRejectionReason::MissingExecutionAuthority(authority.status),
            request.readiness.blockers.clone(),
        );
    }

    if !request.readiness.may_spawn() {
        return rejected(
            &request,
            ProcessSupervisorAcceptanceRejectionReason::ReadinessBlocked(
                request.readiness.status.clone(),
            ),
            request.readiness.blockers.clone(),
        );
    }

    ProcessSupervisorAcceptanceDecision::Accepted(ProcessSupervisorAcceptedEvents {
        accepted: event(
            &request,
            "accepted",
            request.first_sequence.clone(),
            CommandProcessSupervisionEventKind::Accepted,
            CommandProcessSupervisionStatus::Accepted,
            Some("supervisor accepted command for future execution".to_owned()),
        ),
        queued: event(
            &request,
            "queued",
            ServerEventSequence(request.first_sequence.0 + 1),
            CommandProcessSupervisionEventKind::Queued,
            CommandProcessSupervisionStatus::Queued,
            Some("supervisor queued command without process start".to_owned()),
        ),
    })
}

fn rejected(
    request: &ProcessSupervisorAcceptanceRequest,
    reason: ProcessSupervisorAcceptanceRejectionReason,
    blockers: Vec<CommandProcessSupervisionBlocker>,
) -> ProcessSupervisorAcceptanceDecision {
    ProcessSupervisorAcceptanceDecision::Rejected(ProcessSupervisorAcceptanceRejection {
        reason,
        blockers,
        event: event(
            request,
            "blocked",
            request.first_sequence.clone(),
            CommandProcessSupervisionEventKind::Blocked,
            CommandProcessSupervisionStatus::Blocked,
            Some("supervisor rejected command before process start".to_owned()),
        ),
    })
}

fn event(
    request: &ProcessSupervisorAcceptanceRequest,
    suffix: &str,
    sequence: ServerEventSequence,
    kind: CommandProcessSupervisionEventKind,
    status: CommandProcessSupervisionStatus,
    summary: Option<String>,
) -> ProcessSupervisionServerEvent {
    let command_request_id = request.readiness.command_request_id.clone();

    ProcessSupervisionServerEvent {
        id: ServerEventId(event_id(
            "server:event:supervision",
            &command_request_id,
            suffix,
        )),
        sequence,
        occurred_at: None,
        project_id: request.project_id.clone(),
        execution_host_id: request.execution_host_id.clone(),
        payload: CommandProcessSupervisionEventPayload {
            id: CommandProcessSupervisionEventId(event_id(
                "supervision:event",
                &command_request_id,
                suffix,
            )),
            command_request_id,
            kind,
            status,
            terminal_status: None,
            evidence_ref: request.evidence_ref.clone(),
            policy_decision_ref: request.policy_decision_ref.clone(),
            retry_ref: None,
            summary,
        },
        summary: request.summary.clone(),
    }
}

fn event_id(prefix: &str, command_request_id: &CommandRequestId, suffix: &str) -> String {
    format!("{prefix}:{}:{suffix}", command_request_id.0)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use nucleus_command_policy::{
        CommandCancellationPolicy, CommandEnvironmentPolicy, CommandInvocation,
        CommandOutputBoundPolicy, CommandOutputRetention, CommandProcessSupervisionSurface,
        CommandSandboxEnforcement, CommandSandboxProfile, CommandTimeoutPolicy,
    };

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    fn project_id() -> ProjectId {
        ProjectId("project:nucleus".to_owned())
    }

    fn authority_map() -> ProjectAuthorityMap {
        ProjectAuthorityMap {
            project_id: project_id(),
            assignments: vec![crate::ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Execution,
                authoritative_host_id: host(),
                fallback_host_ids: Vec::new(),
                mutation_allowed: true,
                note: None,
            }],
        }
    }

    fn invocation(command_request_id: CommandRequestId) -> CommandInvocation {
        CommandInvocation {
            command_request_id,
            executable: "rg".to_owned(),
            argv: vec!["TODO".to_owned()],
            working_directory: PathBuf::from("."),
            timeout: Duration::from_secs(5),
            stdout_limit_bytes: 16 * 1024,
            stderr_limit_bytes: 16 * 1024,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        }
    }

    fn ready_request() -> ProcessSupervisorAcceptanceRequest {
        let command_request_id = CommandRequestId("command:request:ready".to_owned());
        ProcessSupervisorAcceptanceRequest {
            project_id: project_id(),
            execution_host_id: host(),
            authority_map: authority_map(),
            readiness: CommandProcessSupervisionReadiness {
                command_request_id: command_request_id.clone(),
                invocation: Some(invocation(command_request_id)),
                status: CommandProcessSupervisionReadinessStatus::Ready,
                surfaces: vec![
                    CommandProcessSupervisionSurface::StructuredInvocation,
                    CommandProcessSupervisionSurface::Timeout,
                ],
                blockers: Vec::new(),
                timeout_policy: Some(CommandTimeoutPolicy::RequiredFinite),
                cancellation_policy: Some(CommandCancellationPolicy::Cooperative),
                output_bound_policy: Some(CommandOutputBoundPolicy::Truncate),
                sandbox_enforcement: Some(CommandSandboxEnforcement::Enforced),
                summary: Some("ready".to_owned()),
            },
            evidence_ref: Some(CommandEvidenceRef("evidence:supervision".to_owned())),
            policy_decision_ref: Some(CommandPolicyDecisionRef("policy:accepted".to_owned())),
            first_sequence: ServerEventSequence(1),
            summary: Some("process supervision accepted".to_owned()),
        }
    }

    #[test]
    fn acceptance_skeleton_rejects_blocked_readiness_without_spawning() {
        let mut request = ready_request();
        request.readiness.status = CommandProcessSupervisionReadinessStatus::Blocked;
        request.readiness.blockers =
            vec![nucleus_command_policy::CommandProcessSupervisionBlocker::SandboxNotEnforced];

        let decision = accept_process_supervision_request(request);

        match decision {
            ProcessSupervisorAcceptanceDecision::Rejected(rejection) => {
                assert_eq!(
                    rejection.reason,
                    ProcessSupervisorAcceptanceRejectionReason::ReadinessBlocked(
                        CommandProcessSupervisionReadinessStatus::Blocked
                    )
                );
                assert_eq!(
                    rejection.blockers,
                    vec![nucleus_command_policy::CommandProcessSupervisionBlocker::SandboxNotEnforced]
                );
                assert_eq!(
                    rejection.event.payload.kind,
                    CommandProcessSupervisionEventKind::Blocked
                );
            }
            ProcessSupervisorAcceptanceDecision::Accepted(_) => {
                panic!("blocked readiness must not be accepted")
            }
        }
    }

    #[test]
    fn acceptance_skeleton_rejects_host_without_execution_authority() {
        let mut request = ready_request();
        request.execution_host_id = EngineHostId("host:worker".to_owned());

        let decision = accept_process_supervision_request(request);

        match decision {
            ProcessSupervisorAcceptanceDecision::Rejected(rejection) => {
                assert!(matches!(
                    rejection.reason,
                    ProcessSupervisorAcceptanceRejectionReason::MissingExecutionAuthority(
                        HostAuthorityReadinessStatus::AssignedToDifferentHost { .. }
                    )
                ));
                assert_eq!(
                    rejection.event.payload.kind,
                    CommandProcessSupervisionEventKind::Blocked
                );
            }
            ProcessSupervisorAcceptanceDecision::Accepted(_) => {
                panic!("non-authoritative host must not be accepted")
            }
        }
    }

    #[test]
    fn ready_acceptance_emits_accepted_and_queued_events_only() {
        let decision = accept_process_supervision_request(ready_request());

        match decision {
            ProcessSupervisorAcceptanceDecision::Accepted(events) => {
                assert_eq!(
                    events.accepted.payload.kind,
                    CommandProcessSupervisionEventKind::Accepted
                );
                assert_eq!(
                    events.queued.payload.kind,
                    CommandProcessSupervisionEventKind::Queued
                );
                assert!(events.accepted.payload.terminal_status.is_none());
                assert!(events.queued.payload.terminal_status.is_none());
                assert_eq!(events.accepted.sequence, ServerEventSequence(1));
                assert_eq!(events.queued.sequence, ServerEventSequence(2));
            }
            ProcessSupervisorAcceptanceDecision::Rejected(rejection) => {
                panic!("ready request should be accepted: {rejection:?}")
            }
        }
    }
}
