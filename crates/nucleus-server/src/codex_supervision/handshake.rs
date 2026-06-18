/// Static Codex app-server handshake expectation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakeExpectation {
    pub minimum_version_label: String,
    pub required_client_requests: Vec<String>,
    pub required_server_notifications: Vec<String>,
    pub required_server_requests: Vec<String>,
    pub allow_experimental_user_input: bool,
}

impl CodexAppServerHandshakeExpectation {
    /// First supported method subset from the 2026-06-17 schema evidence.
    pub fn first_supported_subset() -> Self {
        Self {
            minimum_version_label: "codex-cli 0.140.0".to_owned(),
            required_client_requests: vec![
                "initialize".to_owned(),
                "thread/start".to_owned(),
                "thread/resume".to_owned(),
                "turn/start".to_owned(),
                "turn/interrupt".to_owned(),
            ],
            required_server_notifications: vec![
                "thread/started".to_owned(),
                "turn/started".to_owned(),
                "turn/completed".to_owned(),
                "item/started".to_owned(),
                "item/completed".to_owned(),
                "item/agentMessage/delta".to_owned(),
            ],
            required_server_requests: vec![
                "item/commandExecution/requestApproval".to_owned(),
                "item/fileChange/requestApproval".to_owned(),
                "item/permissions/requestApproval".to_owned(),
            ],
            allow_experimental_user_input: true,
        }
    }
}

/// Observed handshake/probe evidence before live work is admitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakeObservation {
    pub version_label: Option<String>,
    pub auth_ready: bool,
    pub generated_json_schema: bool,
    pub generated_ts_bindings: bool,
    pub client_requests: Vec<String>,
    pub server_notifications: Vec<String>,
    pub server_requests: Vec<String>,
    pub experimental_server_requests: Vec<String>,
}

/// Handshake preflight outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerHandshakePreflight {
    pub status: CodexAppServerHandshakePreflightStatus,
    pub blockers: Vec<CodexAppServerHandshakeBlocker>,
}

/// Coarse handshake preflight status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerHandshakePreflightStatus {
    Ready,
    Blocked,
}

/// Reason handshake preflight is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerHandshakeBlocker {
    VersionUnknown,
    UnsupportedVersion { expected: String, observed: String },
    AuthNotReady,
    JsonSchemaMissing,
    TsBindingsMissing,
    RequiredMethodMissing { method: String },
    ExperimentalUserInputNotAllowed,
}
/// Assess static handshake preflight evidence without opening stdio.
pub fn assess_codex_app_server_handshake(
    expectation: &CodexAppServerHandshakeExpectation,
    observation: &CodexAppServerHandshakeObservation,
) -> CodexAppServerHandshakePreflight {
    let mut blockers = Vec::new();

    match &observation.version_label {
        None => blockers.push(CodexAppServerHandshakeBlocker::VersionUnknown),
        Some(version) if version != &expectation.minimum_version_label => {
            blockers.push(CodexAppServerHandshakeBlocker::UnsupportedVersion {
                expected: expectation.minimum_version_label.clone(),
                observed: version.clone(),
            });
        }
        Some(_) => {}
    }

    if !observation.auth_ready {
        blockers.push(CodexAppServerHandshakeBlocker::AuthNotReady);
    }
    if !observation.generated_json_schema {
        blockers.push(CodexAppServerHandshakeBlocker::JsonSchemaMissing);
    }
    if !observation.generated_ts_bindings {
        blockers.push(CodexAppServerHandshakeBlocker::TsBindingsMissing);
    }

    missing_methods(
        &expectation.required_client_requests,
        &observation.client_requests,
        &mut blockers,
    );
    missing_methods(
        &expectation.required_server_notifications,
        &observation.server_notifications,
        &mut blockers,
    );
    missing_methods(
        &expectation.required_server_requests,
        &observation.server_requests,
        &mut blockers,
    );

    if observation
        .experimental_server_requests
        .iter()
        .any(|method| method == "item/tool/requestUserInput")
        && !expectation.allow_experimental_user_input
    {
        blockers.push(CodexAppServerHandshakeBlocker::ExperimentalUserInputNotAllowed);
    }

    let status = if blockers.is_empty() {
        CodexAppServerHandshakePreflightStatus::Ready
    } else {
        CodexAppServerHandshakePreflightStatus::Blocked
    };

    CodexAppServerHandshakePreflight { status, blockers }
}

fn missing_methods(
    required: &[String],
    observed: &[String],
    blockers: &mut Vec<CodexAppServerHandshakeBlocker>,
) {
    for method in required {
        if !observed.contains(method) {
            blockers.push(CodexAppServerHandshakeBlocker::RequiredMethodMissing {
                method: method.clone(),
            });
        }
    }
}
