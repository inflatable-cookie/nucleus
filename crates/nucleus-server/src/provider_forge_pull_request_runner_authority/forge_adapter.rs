//! Adapter boundary for the one admitted forge PR-open write.
//!
//! The adapter owns provider translation only (contract 027 Network
//! Execution Rule). The server-owned execution boundary owns network
//! authority, credential material resolution, idempotency reconciliation,
//! receipts, and sanitized evidence. The first admitted implementation is
//! the forge test double; real provider routes require their own explicit
//! lane.

use std::cell::Cell;
use std::rc::Rc;

use crate::{ForgePullRequestProvider, ForgePullRequestTextSource};

/// Sanitized request for the admitted PR-open call: provider, refs, and
/// title/body source refs only. Raw PR title/body text and credential
/// material never travel through this boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestCreationRequest {
    pub run_id: String,
    pub remote_target: String,
    pub forge_provider: ForgePullRequestProvider,
    pub base_branch: String,
    pub head_branch: String,
    pub title_source: ForgePullRequestTextSource,
    pub body_source: ForgePullRequestTextSource,
}

/// Sanitized provider object reference produced by an open or found by
/// idempotency reconciliation. No raw provider payload, headers, or
/// authorization material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestCreationReference {
    pub pr_reference: String,
    pub pr_url: Option<String>,
}

/// Adapter failures are sanitized: short reason only, no raw provider error
/// payloads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgePullRequestCreationError {
    ApiFailure { reason: String },
    ProviderUnavailable { reason: String },
}

/// Narrow adapter surface for the admitted PR-open write. Adapters
/// translate; the execution boundary reconciles, persists, and receipts.
pub trait ForgePullRequestCreationAdapter {
    /// Idempotency reconciliation: return the existing pull request for the
    /// head branch when one is already open. Must not create anything.
    fn find_existing_pull_request(
        &self,
        request: &ForgePullRequestCreationRequest,
    ) -> Result<Option<ForgePullRequestCreationReference>, ForgePullRequestCreationError>;

    /// Open one pull request for the head branch. Called only after
    /// reconciliation found no existing pull request.
    fn open_pull_request(
        &self,
        request: &ForgePullRequestCreationRequest,
    ) -> Result<ForgePullRequestCreationReference, ForgePullRequestCreationError>;
}

/// Admitted forge test double for PR creation: deterministic behavior for
/// fixtures (happy path, reconciliation, API failure) with shared call
/// counters (clones of the double observe the same counters).
#[derive(Clone, Debug)]
pub struct ForgePullRequestCreationTestDouble {
    pub existing_pull_request: Option<ForgePullRequestCreationReference>,
    pub open_outcome: Result<ForgePullRequestCreationReference, ForgePullRequestCreationError>,
    pub reconcile_calls: Rc<Cell<usize>>,
    pub open_calls: Rc<Cell<usize>>,
}

impl ForgePullRequestCreationTestDouble {
    pub fn new(
        existing_pull_request: Option<ForgePullRequestCreationReference>,
        open_outcome: Result<ForgePullRequestCreationReference, ForgePullRequestCreationError>,
    ) -> Self {
        Self {
            existing_pull_request,
            open_outcome,
            reconcile_calls: Rc::new(Cell::new(0)),
            open_calls: Rc::new(Cell::new(0)),
        }
    }

    pub fn reconcile_call_count(&self) -> usize {
        self.reconcile_calls.get()
    }

    pub fn open_call_count(&self) -> usize {
        self.open_calls.get()
    }
}

impl ForgePullRequestCreationAdapter for ForgePullRequestCreationTestDouble {
    fn find_existing_pull_request(
        &self,
        _request: &ForgePullRequestCreationRequest,
    ) -> Result<Option<ForgePullRequestCreationReference>, ForgePullRequestCreationError> {
        self.reconcile_calls.set(self.reconcile_calls.get() + 1);
        Ok(self.existing_pull_request.clone())
    }

    fn open_pull_request(
        &self,
        _request: &ForgePullRequestCreationRequest,
    ) -> Result<ForgePullRequestCreationReference, ForgePullRequestCreationError> {
        self.open_calls.set(self.open_calls.get() + 1);
        self.open_outcome.clone()
    }
}
