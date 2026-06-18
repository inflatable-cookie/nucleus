use nucleus_agent_protocol::{
    project_codex_app_server_fixture, AdapterRuntimeEvent, CodexAppServerEventFixture,
    CodexAppServerFixtureProjection, CodexFixtureMappingError, CodexRuntimeReceiptFixture,
};

/// One live Codex app-server frame after protocol decoding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveFrame {
    pub fixture: CodexAppServerEventFixture,
    pub transport_sequence: u64,
}

/// Result of ingesting one live Codex frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveIngestion {
    pub sequence: u64,
    pub status: CodexAppServerLiveIngestionStatus,
    pub projection: Option<CodexAppServerLiveProjection>,
    pub unsupported: Option<CodexAppServerUnsupportedObservation>,
}

/// Live ingestion status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveIngestionStatus {
    Accepted,
    Unsupported,
}

/// Live projection into Nucleus-owned runtime surfaces.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveProjection {
    Event(AdapterRuntimeEvent),
    RuntimeReceipt(CodexRuntimeReceiptFixture),
}

/// Unsupported provider event observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerUnsupportedObservation {
    pub method: String,
    pub provider_instance_id: String,
    pub sequence: u64,
    pub reason: String,
    pub raw_payload_policy: CodexRawPayloadPolicy,
}

/// Raw payload retention posture for live Codex ingestion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRawPayloadPolicy {
    MetadataOnly,
    EvidenceRefOnly,
}

/// Ingest one decoded Codex app-server frame through the existing mapper.
pub fn ingest_codex_app_server_live_frame(
    frame: CodexAppServerLiveFrame,
) -> CodexAppServerLiveIngestion {
    let sequence = frame.transport_sequence;
    let provider_instance_id = frame.fixture.provider_instance_id.clone();
    let method = frame.fixture.method.clone();

    match project_codex_app_server_fixture(frame.fixture) {
        Ok(CodexAppServerFixtureProjection::Event(event)) => CodexAppServerLiveIngestion {
            sequence,
            status: CodexAppServerLiveIngestionStatus::Accepted,
            projection: Some(CodexAppServerLiveProjection::Event(event)),
            unsupported: None,
        },
        Ok(CodexAppServerFixtureProjection::RuntimeReceipt(receipt)) => {
            CodexAppServerLiveIngestion {
                sequence,
                status: CodexAppServerLiveIngestionStatus::Accepted,
                projection: Some(CodexAppServerLiveProjection::RuntimeReceipt(receipt)),
                unsupported: None,
            }
        }
        Err(CodexFixtureMappingError { reason, .. }) => CodexAppServerLiveIngestion {
            sequence,
            status: CodexAppServerLiveIngestionStatus::Unsupported,
            projection: None,
            unsupported: Some(CodexAppServerUnsupportedObservation {
                method,
                provider_instance_id,
                sequence,
                reason,
                raw_payload_policy: CodexRawPayloadPolicy::MetadataOnly,
            }),
        },
    }
}
