//! Adapter capability types.

/// Capability matrix for one configured adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCapabilities {
    pub streaming_output: CapabilitySupport,
    pub tool_call_events: CapabilitySupport,
    pub file_edit_events: CapabilitySupport,
    pub permission_prompts: CapabilitySupport,
    pub cancellation: CapabilitySupport,
    pub checkpointing: CapabilitySupport,
    pub resume: CapabilitySupport,
    pub terminal_rendering: CapabilitySupport,
    pub structured_messages: CapabilitySupport,
    pub raw_transcript_access: CapabilitySupport,
    pub model_switch: CapabilitySupport,
    pub account_config_preflight: CapabilitySupport,
    pub multi_instance: CapabilitySupport,
    pub rollback: CapabilitySupport,
    pub provider_native_session_resume: CapabilitySupport,
    pub external_server: CapabilitySupport,
    pub server_spawn: CapabilitySupport,
}

/// Capability support must preserve uncertainty.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapabilitySupport {
    Supported,
    Unsupported,
    Partial(String),
    Unknown,
}
