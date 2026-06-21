use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};

use super::super::stdio_frames::{
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameSourceRecord,
};

pub(super) fn observation_event_from_frame(
    frame: &CodexAppServerStdioFrameSourceRecord,
) -> Option<OrchestrationEventStoreRecord> {
    let method = match &frame.decode_status {
        CodexAppServerStdioDecodeStatus::Decoded { method } => method,
        CodexAppServerStdioDecodeStatus::Malformed { .. }
        | CodexAppServerStdioDecodeStatus::Unsupported { .. }
        | CodexAppServerStdioDecodeStatus::RecoveryRequired { .. } => return None,
    };

    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!(
            "event:codex-stdio-frame-ingestion:{}",
            frame.frame_source_id.0
        )),
        OrchestrationCommandId(format!(
            "command:codex-stdio-frame-ingestion:{}",
            frame.runtime_instance_id
        )),
        Some(format!("{}:{}", frame.runtime_instance_id, method)),
    );

    Some(OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!(
            "stream:codex-stdio-frame-ingestion:{}",
            frame.runtime_instance_id
        )),
        payload,
    ))
}
