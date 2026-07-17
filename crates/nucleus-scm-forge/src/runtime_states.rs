//! Compile-only SCM and forge runtime effect state vocabulary.
//!
//! These records describe state names and final retry classification only.
//! They do not schedule effects, run retries, persist state, replay events,
//! execute commands, call providers, or emit server events.

use crate::effects::{AdapterEffectRequestId, AdapterEffectRetry};

/// Provider-neutral adapter effect state record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterEffectStateRecord {
    pub request_id: AdapterEffectRequestId,
    pub state: AdapterEffectState,
    pub retry: Option<AdapterEffectRetry>,
    pub summary: Option<String>,
}

/// Adapter effect states (shared core vocabulary re-exported under the
/// adapter names).
pub use nucleus_core::{
    EffectNonTerminalState as AdapterEffectNonTerminalState,
    EffectState as AdapterEffectState, EffectTerminalState as AdapterEffectTerminalState,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_effect_state_keeps_recovery_and_cancellation_non_terminal() {
        let cancellation = AdapterEffectStateRecord {
            request_id: AdapterEffectRequestId("effect:cancel".to_owned()),
            state: AdapterEffectState::NonTerminal(
                AdapterEffectNonTerminalState::CancellationRequested,
            ),
            retry: None,
            summary: Some("cancellation requested, outcome pending".to_owned()),
        };
        let recovery = AdapterEffectStateRecord {
            request_id: AdapterEffectRequestId("effect:recover".to_owned()),
            state: AdapterEffectState::NonTerminal(AdapterEffectNonTerminalState::RecoveryRequired),
            retry: Some(AdapterEffectRetry::Retryable),
            summary: Some("server may schedule a recovery request".to_owned()),
        };

        assert!(!cancellation.state.is_terminal());
        assert!(!recovery.state.is_terminal());
        assert_eq!(recovery.retry, Some(AdapterEffectRetry::Retryable));
    }

    #[test]
    fn adapter_effect_state_keeps_terminal_retry_classification_value_only() {
        let timed_out = AdapterEffectStateRecord {
            request_id: AdapterEffectRequestId("effect:timeout".to_owned()),
            state: AdapterEffectState::Terminal(AdapterEffectTerminalState::TimedOut),
            retry: Some(AdapterEffectRetry::TimedOut),
            summary: None,
        };

        assert!(timed_out.state.is_terminal());
        assert_eq!(timed_out.retry, Some(AdapterEffectRetry::TimedOut));
    }
}
