use std::sync::Arc;
use swallowtail_core::Diagnostic;
use swallowtail_runtime::{DebugObservation, DiagnosticObserver};

/// Opt-in Swallowtail debug sink for harness/protocol failure context.
///
/// Enable with `NUCLEUS_SWALLOWTAIL_DEBUG=1` (also accepts `true` / `yes` / `on`).
/// Ordinary product runs leave the observer unregistered.
pub(super) struct SwallowtailDebugObserver;

impl DiagnosticObserver for SwallowtailDebugObserver {
    fn observe(&self, diagnostic: &Diagnostic) {
        let safe = diagnostic.safe();
        eprintln!(
            "nucleus.swallowtail.diagnostic code={} message={}",
            safe.code(),
            safe.message()
        );
        if let Some(detail) = diagnostic.internal_detail() {
            eprintln!("nucleus.swallowtail.diagnostic.internal_detail={detail}");
        }
    }

    fn observe_debug(&self, observation: &DebugObservation) {
        let mut line = format!(
            "nucleus.swallowtail.debug kind={:?}",
            observation.kind()
        );
        if let Some(route) = observation.route() {
            line.push_str(&format!(" route={route}"));
        }
        if let Some(stage) = observation.stage() {
            line.push_str(&format!(" stage={stage}"));
        }
        if let Some(code) = observation.correlated_code() {
            line.push_str(&format!(" code={code}"));
        }
        if let Some(request_id) = observation.request_id() {
            line.push_str(&format!(" request_id={}", request_id.as_str()));
        }
        if let Some(scope_id) = observation.scope_id() {
            line.push_str(&format!(" scope_id={}", scope_id.as_str()));
        }
        line.push_str(&format!(" detail={}", observation.detail()));
        if observation.detail_truncated() {
            line.push_str(" detail_truncated=true");
        }
        eprintln!("{line}");
    }
}

pub(super) fn optional_debug_observer() -> Option<Arc<dyn DiagnosticObserver>> {
    if debug_enabled() {
        Some(Arc::new(SwallowtailDebugObserver) as Arc<dyn DiagnosticObserver>)
    } else {
        None
    }
}

fn debug_enabled() -> bool {
    std::env::var("NUCLEUS_SWALLOWTAIL_DEBUG")
        .map(|value| matches_debug_flag(&value))
        .unwrap_or(false)
}

fn matches_debug_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::SwallowtailDebugObserver;
    use std::sync::{Arc, Mutex};
    use swallowtail_core::{Diagnostic, ExecutionHostId, SafeDiagnostic};
    use swallowtail_runtime::{
        DebugObservation, DebugObservationKind, DiagnosticObserver, HostServices,
    };

    #[derive(Default)]
    struct RecordingObserver {
        debug: Mutex<Vec<String>>,
    }

    impl DiagnosticObserver for RecordingObserver {
        fn observe(&self, _diagnostic: &Diagnostic) {}

        fn observe_debug(&self, observation: &DebugObservation) {
            self.debug
                .lock()
                .expect("lock")
                .push(observation.detail().to_owned());
        }
    }

    #[test]
    fn host_services_deliver_debug_observations_to_registered_observer() {
        let observer = Arc::new(RecordingObserver::default());
        let services =
            HostServices::new(ExecutionHostId::new("nucleus.test").expect("host id"))
                .with_diagnostic_observer(observer.clone());

        services.emit_debug_observation(
            &DebugObservation::new(
                DebugObservationKind::ProtocolParse,
                "method=item/plan/delta; excerpt=<path>",
            )
            .with_route("codex.app-server")
            .with_stage("rpc.pump.inbound")
            .with_correlated_code("swallowtail.codex.app_server.malformed_notification"),
        );

        let details = observer.debug.lock().expect("lock").clone();
        assert_eq!(
            details,
            vec!["method=item/plan/delta; excerpt=<path>".to_owned()]
        );
        let _ = SwallowtailDebugObserver;
        let _ = Diagnostic::new(SafeDiagnostic::new("fixture", "fixture"));
    }

    #[test]
    fn truthy_debug_flag_values_are_recognized() {
        for value in ["1", "true", "YES", "On"] {
            assert!(super::matches_debug_flag(value), "{value}");
        }
        for value in ["0", "false", "", "maybe"] {
            assert!(!super::matches_debug_flag(value), "{value}");
        }
    }
}
