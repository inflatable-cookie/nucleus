//! Codex callback response admission policy.
//!
//! Admission records gate a callback response before any provider send. They do
//! not build provider envelopes, write stdio, retain raw payloads, or mutate
//! task state.

use nucleus_agent_protocol::{ApprovalScope, UserInputPromptKind};

use super::callback_request::{
    CodexAppServerCallbackRequest, CodexAppServerCallbackRequestKind,
    CodexAppServerProviderCallbackId,
};

/// Stable id for one callback-response admission decision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseAdmissionId(pub String);

/// Operator/client response intent for a Codex callback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponse {
    Permission { selected_option: String },
    UserInput { values: Vec<String> },
}

/// Input used to admit or block a Codex callback response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseAdmissionInput {
    pub request: CodexAppServerCallbackRequest,
    pub response: CodexAppServerCallbackResponse,
    pub response_authority_confirmed: bool,
    pub runtime_ready_evidence_refs: Vec<String>,
    pub raw_payload_policy_confirmed: bool,
}

/// Admission record for a callback response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseAdmission {
    pub admission_id: CodexAppServerCallbackResponseAdmissionId,
    pub request_id: String,
    pub provider_callback_id: CodexAppServerProviderCallbackId,
    pub response: CodexAppServerCallbackResponse,
    pub status: CodexAppServerCallbackResponseAdmissionStatus,
    pub blockers: Vec<CodexAppServerCallbackResponseAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_send_started: bool,
    pub raw_provider_payload_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseAdmissionStatus {
    Accepted,
    Blocked(String),
    Unsupported(String),
}

/// Reason callback-response admission is blocked or unsupported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseAdmissionBlocker {
    MissingResponseAuthority,
    MissingRuntimeReadyEvidence,
    RawPayloadPolicyUnconfirmed,
    EmptyPermissionSelection,
    EmptyUserInputValue,
    EmptyUserInputValues,
    PermissionOptionNotAllowed(String),
    UserInputOptionNotAllowed(String),
    ResponseKindMismatch,
    ProviderSpecificPermissionScope(String),
    ProviderSpecificUserInputKind(String),
}

/// Admit or block a Codex callback response before provider send.
pub fn admit_codex_callback_response(
    input: CodexAppServerCallbackResponseAdmissionInput,
) -> CodexAppServerCallbackResponseAdmission {
    let blockers = admission_blockers(&input);
    let unsupported = unsupported_blockers(&blockers);
    let status = if !unsupported.is_empty() {
        CodexAppServerCallbackResponseAdmissionStatus::Unsupported(blocker_summary(&unsupported))
    } else if blockers.is_empty() {
        CodexAppServerCallbackResponseAdmissionStatus::Accepted
    } else {
        CodexAppServerCallbackResponseAdmissionStatus::Blocked(blocker_summary(&blockers))
    };
    let request_id = input.request.request_id().0.clone();
    let mut evidence_refs = input.request.evidence_refs().to_vec();
    evidence_refs.extend(input.runtime_ready_evidence_refs);

    CodexAppServerCallbackResponseAdmission {
        admission_id: CodexAppServerCallbackResponseAdmissionId(format!(
            "codex-callback-response-admission:{request_id}"
        )),
        request_id,
        provider_callback_id: input.request.provider_callback_id().clone(),
        response: input.response,
        status,
        blockers,
        evidence_refs,
        provider_send_started: false,
        raw_provider_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn admission_blockers(
    input: &CodexAppServerCallbackResponseAdmissionInput,
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    let mut blockers = common_blockers(input);
    blockers.extend(response_shape_blockers(
        input.request.kind(),
        &input.response,
    ));
    blockers
}

fn common_blockers(
    input: &CodexAppServerCallbackResponseAdmissionInput,
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    let mut blockers = Vec::new();

    if !input.response_authority_confirmed {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::MissingResponseAuthority);
    }
    if input.runtime_ready_evidence_refs.is_empty() {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::MissingRuntimeReadyEvidence);
    }
    if !input.raw_payload_policy_confirmed {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::RawPayloadPolicyUnconfirmed);
    }

    blockers
}

fn response_shape_blockers(
    request_kind: &CodexAppServerCallbackRequestKind,
    response: &CodexAppServerCallbackResponse,
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    match (request_kind, response) {
        (
            CodexAppServerCallbackRequestKind::Permission { scope, options },
            CodexAppServerCallbackResponse::Permission { selected_option },
        ) => permission_blockers(scope, options, selected_option),
        (
            CodexAppServerCallbackRequestKind::UserInput { kind, options },
            CodexAppServerCallbackResponse::UserInput { values },
        ) => user_input_blockers(kind, options, values),
        _ => vec![CodexAppServerCallbackResponseAdmissionBlocker::ResponseKindMismatch],
    }
}

fn permission_blockers(
    scope: &ApprovalScope,
    options: &[String],
    selected_option: &str,
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    let mut blockers = Vec::new();

    if let ApprovalScope::ProviderSpecific(scope) = scope {
        blockers.push(
            CodexAppServerCallbackResponseAdmissionBlocker::ProviderSpecificPermissionScope(
                scope.clone(),
            ),
        );
    }
    if selected_option.is_empty() {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::EmptyPermissionSelection);
    } else if !options.iter().any(|option| option == selected_option) {
        blockers.push(
            CodexAppServerCallbackResponseAdmissionBlocker::PermissionOptionNotAllowed(
                selected_option.to_owned(),
            ),
        );
    }

    blockers
}

fn user_input_blockers(
    kind: &UserInputPromptKind,
    options: &[String],
    values: &[String],
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    let mut blockers = Vec::new();

    if let UserInputPromptKind::ProviderSpecific(kind) = kind {
        blockers.push(
            CodexAppServerCallbackResponseAdmissionBlocker::ProviderSpecificUserInputKind(
                kind.clone(),
            ),
        );
    }
    if values.is_empty() {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::EmptyUserInputValues);
        return blockers;
    }
    if values.iter().any(|value| value.is_empty()) {
        blockers.push(CodexAppServerCallbackResponseAdmissionBlocker::EmptyUserInputValue);
    }
    if user_input_requires_options(kind) {
        blockers.extend(
            values
                .iter()
                .filter(|value| !value.is_empty() && !options.iter().any(|option| option == *value))
                .map(|value| {
                    CodexAppServerCallbackResponseAdmissionBlocker::UserInputOptionNotAllowed(
                        value.clone(),
                    )
                }),
        );
    }
    if matches!(kind, UserInputPromptKind::SelectOne) && values.len() != 1 {
        blockers.push(
            CodexAppServerCallbackResponseAdmissionBlocker::UserInputOptionNotAllowed(
                values.join(","),
            ),
        );
    }

    blockers
}

fn user_input_requires_options(kind: &UserInputPromptKind) -> bool {
    matches!(
        kind,
        UserInputPromptKind::SelectOne | UserInputPromptKind::SelectMany
    )
}

fn unsupported_blockers(
    blockers: &[CodexAppServerCallbackResponseAdmissionBlocker],
) -> Vec<CodexAppServerCallbackResponseAdmissionBlocker> {
    blockers
        .iter()
        .filter(|blocker| {
            matches!(
                blocker,
                CodexAppServerCallbackResponseAdmissionBlocker::ResponseKindMismatch
                    | CodexAppServerCallbackResponseAdmissionBlocker::ProviderSpecificPermissionScope(_)
                    | CodexAppServerCallbackResponseAdmissionBlocker::ProviderSpecificUserInputKind(_)
            )
        })
        .cloned()
        .collect()
}

fn blocker_summary(blockers: &[CodexAppServerCallbackResponseAdmissionBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| format!("{blocker:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_callback_request, codex_runtime_instance_from_supervision_request,
        CodexAppServerBinary, CodexAppServerCallbackPromptRef,
        CodexAppServerCallbackPromptRetentionPolicy, CodexAppServerPayloadRetentionPolicy,
        CodexAppServerRuntimeInstanceRecord, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_projects::ProjectId;
    use nucleus_tasks::TaskId;

    fn runtime() -> CodexAppServerRuntimeInstanceRecord {
        codex_runtime_instance_from_supervision_request(
            &CodexAppServerSupervisionRequest {
                project_id: ProjectId("project:1".to_owned()),
                execution_host_id: EngineHostId("host:local".to_owned()),
                adapter: AdapterIdentity {
                    adapter_id: "codex-app-server".to_owned(),
                    provider_driver_kind: ProviderDriverKind::Codex,
                    provider_instance_id: "codex:local-default".to_owned(),
                    provider_name: "OpenAI Codex".to_owned(),
                    harness_name: "Codex app-server".to_owned(),
                    transport_family: TransportFamily::StructuredAppServerRuntime,
                    version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
                    authentication_preflight: AuthenticationPreflight::Command(
                        "codex doctor --json".to_owned(),
                    ),
                },
                binary: CodexAppServerBinary {
                    command: "codex".to_owned(),
                    version_label: Some("codex-cli 0.140.0".to_owned()),
                    available: true,
                },
                schema_evidence: CodexAppServerSchemaEvidenceRef {
                    evidence_ref: "evidence:codex-schema".to_owned(),
                    codex_version: "codex-cli 0.140.0".to_owned(),
                    generated_json_schema: true,
                    generated_ts_bindings: true,
                },
                supervision_limits: CodexAppServerSupervisionLimits {
                    max_sessions: 1,
                    allow_raw_provider_payload_storage: false,
                    allow_live_spawn: true,
                },
            },
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    fn prompt_ref() -> CodexAppServerCallbackPromptRef {
        CodexAppServerCallbackPromptRef {
            prompt_ref: "callback-prompt:1".to_owned(),
            summary: "callback summary".to_owned(),
            retention: CodexAppServerCallbackPromptRetentionPolicy::SummaryAndRefOnly,
        }
    }

    fn permission_request() -> CodexAppServerCallbackRequest {
        codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned()),
            AgentSessionId("session:1".to_owned()),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:1".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerCallbackRequestKind::Permission {
                scope: ApprovalScope::Command,
                options: vec!["allow".to_owned(), "deny".to_owned()],
            },
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("callback request")
    }

    fn user_input_request(kind: UserInputPromptKind) -> CodexAppServerCallbackRequest {
        codex_callback_request(
            &runtime(),
            CodexAppServerProviderCallbackId("provider-callback:input".to_owned()),
            AgentSessionId("session:1".to_owned()),
            Some("turn:provider:1".to_owned()),
            Some("item:provider:input".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerCallbackRequestKind::UserInput {
                kind,
                options: vec!["first".to_owned(), "second".to_owned()],
            },
            prompt_ref(),
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("callback request")
    }

    fn input(
        request: CodexAppServerCallbackRequest,
        response: CodexAppServerCallbackResponse,
    ) -> CodexAppServerCallbackResponseAdmissionInput {
        CodexAppServerCallbackResponseAdmissionInput {
            request,
            response,
            response_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            raw_payload_policy_confirmed: true,
        }
    }

    #[test]
    fn callback_response_admission_accepts_authorized_permission_option_without_send() {
        let admission = admit_codex_callback_response(input(
            permission_request(),
            CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
        ));

        assert_eq!(
            admission.status,
            CodexAppServerCallbackResponseAdmissionStatus::Accepted
        );
        assert_eq!(
            admission.provider_callback_id,
            CodexAppServerProviderCallbackId("provider-callback:1".to_owned())
        );
        assert_eq!(
            admission.response,
            CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned()
            }
        );
        assert!(admission
            .evidence_refs
            .contains(&"evidence:live-spawn-smoke".to_owned()));
        assert!(!admission.provider_send_started);
        assert!(!admission.raw_provider_payload_retained);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn callback_response_admission_blocks_missing_authority_or_invalid_option() {
        let mut input = input(
            permission_request(),
            CodexAppServerCallbackResponse::Permission {
                selected_option: "maybe".to_owned(),
            },
        );
        input.response_authority_confirmed = false;
        input.runtime_ready_evidence_refs.clear();

        let admission = admit_codex_callback_response(input);

        assert!(matches!(
            admission.status,
            CodexAppServerCallbackResponseAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerCallbackResponseAdmissionBlocker::MissingResponseAuthority));
        assert!(admission.blockers.contains(
            &CodexAppServerCallbackResponseAdmissionBlocker::MissingRuntimeReadyEvidence
        ));
        assert!(admission.blockers.contains(
            &CodexAppServerCallbackResponseAdmissionBlocker::PermissionOptionNotAllowed(
                "maybe".to_owned()
            )
        ));
        assert!(!admission.provider_send_started);
        assert!(!admission.task_mutation_permitted);
    }

    #[test]
    fn callback_response_admission_accepts_select_user_input_values() {
        let admission = admit_codex_callback_response(input(
            user_input_request(UserInputPromptKind::SelectOne),
            CodexAppServerCallbackResponse::UserInput {
                values: vec!["first".to_owned()],
            },
        ));

        assert_eq!(
            admission.status,
            CodexAppServerCallbackResponseAdmissionStatus::Accepted
        );
        assert!(!admission.provider_send_started);
    }

    #[test]
    fn callback_response_admission_reports_unsupported_response_shape() {
        let admission = admit_codex_callback_response(input(
            user_input_request(UserInputPromptKind::ProviderSpecific(
                "custom-picker".to_owned(),
            )),
            CodexAppServerCallbackResponse::Permission {
                selected_option: "allow".to_owned(),
            },
        ));

        assert!(matches!(
            admission.status,
            CodexAppServerCallbackResponseAdmissionStatus::Unsupported(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerCallbackResponseAdmissionBlocker::ResponseKindMismatch));
        assert!(!admission.provider_send_started);
        assert!(!admission.task_mutation_permitted);
    }
}
