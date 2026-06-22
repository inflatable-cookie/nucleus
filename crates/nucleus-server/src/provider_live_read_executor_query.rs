//! Read-only query composition for provider live-read executor diagnostics.

use crate::{
    provider_live_read_server_executor_diagnostics, ProviderLiveReadServerExecutorDiagnostics,
};

pub fn query_provider_live_read_executor_diagnostics() -> ProviderLiveReadServerExecutorDiagnostics
{
    provider_live_read_server_executor_diagnostics(Vec::new(), Vec::new(), Vec::new(), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executor_diagnostics_query_is_empty_and_has_no_effects() {
        let diagnostics = query_provider_live_read_executor_diagnostics();

        assert_eq!(diagnostics.request_count, 0);
        assert_eq!(diagnostics.provider_network_read_performed_count, 0);
        assert!(!diagnostics.provider_write_executed);
        assert!(!diagnostics.callback_effect_executed);
        assert!(!diagnostics.interruption_effect_executed);
        assert!(!diagnostics.recovery_effect_executed);
        assert!(!diagnostics.task_mutation_executed);
        assert!(!diagnostics.raw_provider_payload_retained);
    }
}
