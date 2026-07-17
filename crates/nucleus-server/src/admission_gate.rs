//! Generic admission-gate framework.
//!
//! A gate declares its input, blocker, status, and no-effects types plus two
//! pure functions (find blockers, classify status). The framework produces
//! the admission outcome. New gates implement [`AdmissionGate`] in one file
//! instead of stamping the types/blockers/record_builder/diagnostics kit;
//! existing stamped families migrate opportunistically.

/// One admission gate: pure blocker discovery plus status classification.
pub trait AdmissionGate {
    /// Structured request the gate inspects. Never executed, only classified.
    type Input;
    /// Why admission cannot proceed (or needs repair/approval).
    type Blocker;
    /// Domain status produced from the blocker set.
    type Status;
    /// The gate's no-effects claim struct; `Default` must mean "nothing ran".
    type NoEffects: Default;

    /// Stable gate identity used in record ids and diagnostics.
    const GATE_ID: &'static str;

    /// All blockers for this input. Empty means admissible.
    fn blockers(input: &Self::Input) -> Vec<Self::Blocker>;

    /// Classify the blocker set into the domain status.
    fn classify(blockers: &[Self::Blocker]) -> Self::Status;

    /// Sanitized evidence refs carried into the outcome.
    fn evidence_refs(_input: &Self::Input) -> Vec<String> {
        Vec::new()
    }
}

/// Outcome of running one admission gate. Pure data; nothing executed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionOutcome<Status, Blocker, NoEffects> {
    pub gate_id: &'static str,
    pub status: Status,
    pub blockers: Vec<Blocker>,
    pub evidence_refs: Vec<String>,
    pub no_effects: NoEffects,
}

/// Run a gate over one input.
pub fn admit<G: AdmissionGate>(
    input: &G::Input,
) -> AdmissionOutcome<G::Status, G::Blocker, G::NoEffects> {
    let blockers = G::blockers(input);
    AdmissionOutcome {
        gate_id: G::GATE_ID,
        status: G::classify(&blockers),
        blockers,
        evidence_refs: G::evidence_refs(input),
        no_effects: G::NoEffects::default(),
    }
}

/// Count records whose extracted status equals `status` — replaces the
/// per-family `*_count` helper clones in diagnostics modules.
pub fn count_by_status<T, S: PartialEq>(
    records: &[T],
    status: &S,
    status_of: impl Fn(&T) -> &S,
) -> usize {
    records
        .iter()
        .filter(|record| status_of(record) == status)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DemoGate;

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum DemoBlocker {
        MissingRef,
        Forbidden,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum DemoStatus {
        Ready,
        RepairRequired,
        Blocked,
    }

    impl AdmissionGate for DemoGate {
        type Input = (Option<String>, bool);
        type Blocker = DemoBlocker;
        type Status = DemoStatus;
        type NoEffects = crate::provider_no_effects::ProviderNoEffects;

        const GATE_ID: &'static str = "demo-gate";

        fn blockers(input: &Self::Input) -> Vec<DemoBlocker> {
            let mut blockers = Vec::new();
            if input.0.is_none() {
                blockers.push(DemoBlocker::MissingRef);
            }
            if input.1 {
                blockers.push(DemoBlocker::Forbidden);
            }
            blockers
        }

        fn classify(blockers: &[DemoBlocker]) -> DemoStatus {
            if blockers.is_empty() {
                DemoStatus::Ready
            } else if blockers.contains(&DemoBlocker::Forbidden) {
                DemoStatus::Blocked
            } else {
                DemoStatus::RepairRequired
            }
        }
    }

    #[test]
    fn gate_outcome_carries_status_blockers_and_default_no_effects() {
        let ready = admit::<DemoGate>(&(Some("ref".to_owned()), false));
        assert_eq!(ready.status, DemoStatus::Ready);
        assert!(ready.blockers.is_empty());
        assert!(ready.no_effects.is_none_executed());

        let blocked = admit::<DemoGate>(&(None, true));
        assert_eq!(blocked.status, DemoStatus::Blocked);
        assert_eq!(blocked.blockers.len(), 2);
        assert_eq!(blocked.gate_id, "demo-gate");
    }

    #[test]
    fn count_by_status_replaces_per_family_count_helpers() {
        let records = vec![DemoStatus::Ready, DemoStatus::Blocked, DemoStatus::Ready];
        assert_eq!(
            count_by_status(&records, &DemoStatus::Ready, |status| status),
            2
        );
    }
}
