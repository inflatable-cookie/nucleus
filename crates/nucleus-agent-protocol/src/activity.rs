//! Portable Swallowtail activity crossing the Nucleus adapter boundary.
//!
//! Nucleus deliberately carries the provider-neutral Swallowtail observation
//! instead of defining a second activity vocabulary.

use swallowtail_runtime::ActivityObservation;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentActivityEvent {
    pub sequence: u64,
    pub observation: ActivityObservation,
}

impl AgentActivityEvent {
    #[must_use]
    pub const fn new(sequence: u64, observation: ActivityObservation) -> Self {
        Self {
            sequence,
            observation,
        }
    }
}

pub type AgentActivityHandler<'a> = dyn FnMut(AgentActivityEvent) -> Result<(), String> + 'a;
