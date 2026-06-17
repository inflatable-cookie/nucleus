use nucleus_command_policy::CommandProcessSupervisionEventKind;

use crate::host_authority::EngineHostId;

/// Stable local event transport channel id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalEventTransportChannelId(pub String);

/// Local in-process event transport backend owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalEventTransportBackend {
    pub execution_host_id: EngineHostId,
    pub channel: LocalSupervisionEventChannel,
}

/// In-process supervision event channel vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalSupervisionEventChannel {
    pub id: LocalEventTransportChannelId,
    pub supported_event_kinds: Vec<CommandProcessSupervisionEventKind>,
    pub bounded_in_process_delivery: bool,
    pub replay_posture: LocalEventTransportReplayPosture,
}

/// Replay posture for the first local event transport slice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalEventTransportReplayPosture {
    Unsupported,
    MetadataRefsOnly,
    DurableStore,
}

/// Local event transport failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalEventTransportError {
    HostMismatch {
        expected: EngineHostId,
        actual: EngineHostId,
    },
}
