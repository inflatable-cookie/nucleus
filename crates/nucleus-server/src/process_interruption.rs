//! Server-owned process interruption contract envelope.
//!
//! These records bind timeout, cancellation, cleanup, and retry contract values
//! to an execution host. They do not implement async process control,
//! cancellation, kill-tree behavior, cleanup, retry scheduling, or event
//! transport.

use nucleus_command_policy::CommandProcessInterruptionContract;

use crate::host_authority::EngineHostId;

/// Process interruption contract advertised by one execution host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessInterruptionHostContract {
    pub execution_host_id: EngineHostId,
    pub contract: CommandProcessInterruptionContract,
    pub implementation_ref: Option<String>,
}

impl ProcessInterruptionHostContract {
    /// Returns true when the host contract is specific enough for future spawn.
    pub fn supports_future_spawn(&self) -> bool {
        self.contract.is_ready_for_spawn_contract()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::{
        CommandCancellationPolicy, CommandCleanupFailurePolicy, CommandTimeoutPolicy,
        CommandTimeoutStartPolicy,
    };

    #[test]
    fn host_interruption_contract_requires_cleanup_failed_event_policy() {
        let contract = ProcessInterruptionHostContract {
            execution_host_id: EngineHostId("host:local".to_owned()),
            contract: CommandProcessInterruptionContract {
                timeout_policy: CommandTimeoutPolicy::RequiredFinite,
                timeout_start_policy: CommandTimeoutStartPolicy::BeforeSpawnAttempt,
                cancellation_policy: CommandCancellationPolicy::Cooperative,
                cleanup_failure_policy: CommandCleanupFailurePolicy::Unsupported,
                finite_timeout_required: true,
                terminal_event_required: true,
                retry_classification_policy_aware: true,
                summary: Some("cleanup policy missing".to_owned()),
            },
            implementation_ref: None,
        };

        assert!(!contract.supports_future_spawn());
    }
}
